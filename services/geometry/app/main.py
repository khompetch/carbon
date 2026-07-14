"""FastAPI entrypoint for the Carbon geometry service.

Wire format is defined in docs/specs/animated-work-instructions-contracts.md.
"""

import json
import logging
import shutil
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app import __version__, config
from app.auth import require_auth
from app.errors import ConvertError
from app.schemas import (
    ConvertRequest,
    ConvertResponse,
    ConvertStats,
    HealthResponse,
    PlanOptions,
    PlanRequest,
    PlanStartResponse,
    PlanStats,
    PlanStatusResponse,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("geometry")

HTTP_TIMEOUT_S = 120.0

_conversion_slots = threading.BoundedSemaphore(config.max_concurrency())

app = FastAPI(title="carbon-geometry", version=__version__)


@app.exception_handler(ConvertError)
async def convert_error_handler(_: Request, exc: ConvertError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"ok": False, "error": exc.message, "code": exc.code},
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(
    _: Request, exc: RequestValidationError
) -> JSONResponse:
    return JSONResponse(
        status_code=400,
        content={"ok": False, "error": str(exc.errors()), "code": "INVALID_INPUT"},
    )


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(version=__version__)


@app.post("/convert", response_model=ConvertResponse, dependencies=[Depends(require_auth)])
def convert(request: ConvertRequest) -> ConvertResponse:
    # OCP import is deferred so the API (auth, validation, /health) works in
    # environments without the OCCT wheel (and fails with a clear error here).
    try:
        from app.convert import convert_step
    except ImportError as exc:
        raise ConvertError(
            "TESSELLATION_FAILED", f"OCCT bindings unavailable: {exc}"
        ) from exc
    from app.optimize import compress_glb

    for url in (
        request.source.url,
        request.outputs.glb.url,
        request.outputs.graph.url,
    ):
        _validate_url(url)

    if not _conversion_slots.acquire(blocking=False):
        raise ConvertError("BUSY", "all conversion slots are in use; retry later", 429)

    started = time.monotonic()
    logger.info("[%s] convert start: %s", request.jobId, request.source.format)

    try:
        with tempfile.TemporaryDirectory(prefix="geometry-") as tmp:
            tmp_dir = Path(tmp)
            step_path = tmp_dir / "source.step"
            glb_path = tmp_dir / "model.glb"
            _download(request.source.url, step_path)

            result = convert_step(
                step_path,
                glb_path,
                linear_deflection=request.options.linearDeflection,
                angular_deflection=request.options.angularDeflection,
                max_parts=config.max_parts(),
            )

            if request.options.compress:
                compressed_path = tmp_dir / "model.meshopt.glb"
                if compress_glb(glb_path, compressed_path):
                    glb_path = compressed_path
                else:
                    result.warnings.append(
                        "meshopt compression unavailable; GLB is uncompressed"
                    )

            _upload(
                request.outputs.glb.url, glb_path.read_bytes(), "model/gltf-binary"
            )
            _upload(
                request.outputs.graph.url,
                json.dumps(result.graph).encode("utf-8"),
                "application/json",
            )
    finally:
        _conversion_slots.release()

    convert_ms = int((time.monotonic() - started) * 1000)
    logger.info(
        "[%s] convert done: %d parts, %d triangles, %dms",
        request.jobId,
        result.component_count,
        result.triangles,
        convert_ms,
    )
    return ConvertResponse(
        componentCount=result.component_count,
        unit=result.graph["unit"],
        stats=ConvertStats(
            convertMs=convert_ms,
            meshTriangles=result.triangles,
            warnings=result.warnings,
        ),
    )


# --- Async plan jobs -----------------------------------------------------
# Planning runs in a background thread keyed by jobId; the caller polls
# GET /plan/{jobId}. Jobs live in-process (dev-scale) — a service restart drops
# them and the caller re-submits. Slots are held only while a job runs, so
# submissions queue rather than 429 when both slots are busy.
_plan_jobs: dict[str, dict] = {}
_plan_jobs_lock = threading.Lock()
_PLAN_JOB_TTL_S = 60 * 60


def _plan_job_get(job_id: str) -> dict | None:
    with _plan_jobs_lock:
        job = _plan_jobs.get(job_id)
        return dict(job) if job else None


def _plan_job_set(job_id: str, **fields: object) -> None:
    with _plan_jobs_lock:
        job = _plan_jobs.setdefault(job_id, {})
        job.update(fields)
        job["updatedAt"] = time.time()


def _plan_jobs_prune() -> None:
    cutoff = time.time() - _PLAN_JOB_TTL_S
    with _plan_jobs_lock:
        for key in [
            k for k, v in _plan_jobs.items() if v.get("updatedAt", 0.0) < cutoff
        ]:
            _plan_jobs.pop(key, None)


def _run_plan_job(job_id: str, source_url: str, options: PlanOptions) -> None:
    from app.plan import plan_step

    _conversion_slots.acquire()
    tmp = tempfile.mkdtemp(prefix="geometry-")
    started = time.monotonic()
    logger.info("[%s] plan start: step", job_id)
    try:
        _plan_job_set(job_id, status="running")
        step_path = Path(tmp) / "source.step"
        _download(source_url, step_path)

        result = plan_step(
            step_path,
            linear_deflection=options.linearDeflection,
            angular_deflection=options.angularDeflection,
            clearance=options.clearance,
            path_samples=options.pathSamples,
            max_parts=config.max_parts(),
            units=(
                [u.model_dump() for u in options.units] if options.units else None
            ),
            sequence=options.sequence,
        )

        plan_ms = int((time.monotonic() - started) * 1000)
        logger.info(
            "[%s] plan done: %d/%d parts planned, tiers=%s, %dms",
            job_id,
            result.planned_count,
            result.component_count,
            result.tiers,
            plan_ms,
        )
        _plan_job_set(
            job_id,
            status="done",
            plan=result.plan,
            componentCount=result.component_count,
            plannedCount=result.planned_count,
            stats={
                "planMs": plan_ms,
                "tiers": result.tiers,
                "warnings": result.warnings,
                "verifiedCount": result.verified_count,
            },
        )
    except ConvertError as exc:
        logger.exception("[%s] plan failed", job_id)
        _plan_job_set(job_id, status="error", error=exc.message)
    except Exception as exc:  # noqa: BLE001 - surface any planner failure to caller
        logger.exception("[%s] plan failed", job_id)
        _plan_job_set(job_id, status="error", error=str(exc))
    finally:
        _conversion_slots.release()
        shutil.rmtree(tmp, ignore_errors=True)


@app.post(
    "/plan",
    status_code=202,
    response_model=PlanStartResponse,
    dependencies=[Depends(require_auth)],
)
def plan(request: PlanRequest) -> PlanStartResponse:
    try:
        from app.plan import plan_step  # noqa: F401 - fail fast if deps missing
    except ImportError as exc:
        raise ConvertError(
            "TESSELLATION_FAILED", f"planner dependencies unavailable: {exc}"
        ) from exc

    _validate_url(request.source.url)

    _plan_jobs_prune()
    job_id = request.jobId
    with _plan_jobs_lock:
        existing = _plan_jobs.get(job_id)
        if existing and existing.get("status") in ("pending", "running"):
            # Idempotent: a duplicate submit (e.g. an Inngest retry) attaches to
            # the run already in flight rather than starting a second planner.
            return PlanStartResponse(jobId=job_id, status=str(existing["status"]))
        _plan_jobs[job_id] = {"status": "pending", "updatedAt": time.time()}

    threading.Thread(
        target=_run_plan_job,
        args=(job_id, request.source.url, request.options),
        daemon=True,
    ).start()
    return PlanStartResponse(jobId=job_id, status="pending")


@app.get(
    "/plan/{job_id}",
    response_model=PlanStatusResponse,
    dependencies=[Depends(require_auth)],
)
def plan_status(job_id: str) -> PlanStatusResponse:
    job = _plan_job_get(job_id)
    if job is None:
        raise ConvertError("NOT_FOUND", f"no plan job {job_id}", 404)
    status = str(job["status"])
    if status == "done":
        return PlanStatusResponse(
            status="done",
            plan=job["plan"],
            componentCount=job["componentCount"],
            plannedCount=job["plannedCount"],
            stats=PlanStats(**job["stats"]),
        )
    if status == "error":
        return PlanStatusResponse(status="error", error=job.get("error"))
    return PlanStatusResponse(status=status)


def _validate_url(url: str) -> None:
    parsed = urlparse(url)
    if config.require_https() and parsed.scheme != "https":
        raise ConvertError("INVALID_INPUT", "URLs must use https", 400)
    if parsed.scheme not in ("http", "https"):
        raise ConvertError("INVALID_INPUT", f"unsupported URL scheme: {parsed.scheme}", 400)
    allowed = config.allowed_url_hosts()
    if allowed and (parsed.hostname or "").lower() not in allowed:
        raise ConvertError("INVALID_INPUT", "URL host is not allowed", 400)


def _download(url: str, destination: Path) -> None:
    limit = config.max_source_bytes()
    try:
        with httpx.Client(
            timeout=HTTP_TIMEOUT_S,
            follow_redirects=True,
            verify=config.verify_tls(),
        ) as client:
            with client.stream("GET", url) as response:
                response.raise_for_status()
                declared = response.headers.get("Content-Length")
                if declared and int(declared) > limit:
                    raise ConvertError(
                        "LIMIT_EXCEEDED", "source file exceeds the size limit", 413
                    )
                received = 0
                with destination.open("wb") as out:
                    for chunk in response.iter_bytes():
                        received += len(chunk)
                        if received > limit:
                            raise ConvertError(
                                "LIMIT_EXCEEDED",
                                "source file exceeds the size limit",
                                413,
                            )
                        out.write(chunk)
    except httpx.HTTPError as exc:
        raise ConvertError("READ_FAILED", f"could not download source: {exc}", 422) from exc


def _upload(url: str, body: bytes, content_type: str) -> None:
    try:
        with httpx.Client(timeout=HTTP_TIMEOUT_S, verify=config.verify_tls()) as client:
            response = client.put(
                url,
                content=body,
                # Retried jobs re-upload to the same path; without upsert the
                # storage API rejects the second attempt with a 400
                headers={"Content-Type": content_type, "x-upsert": "true"},
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text[:200] if exc.response is not None else ""
        raise ConvertError(
            "UPLOAD_FAILED",
            f"could not upload artifact: {exc} {detail}".strip(),
            502,
        ) from exc
    except httpx.HTTPError as exc:
        raise ConvertError("UPLOAD_FAILED", f"could not upload artifact: {exc}", 502) from exc
