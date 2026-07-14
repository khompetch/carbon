"""Meshopt compression via the @gltf-transform/cli Node tool.

gltf-transform preserves node extras (verified in tests), so the stamped
nodeIds survive compression. If the CLI is unavailable or fails, the caller
falls back to the uncompressed GLB.
"""

import logging
import subprocess
from pathlib import Path

logger = logging.getLogger("geometry.optimize")

COMPRESS_TIMEOUT_S = 600


def compress_glb(source: Path, destination: Path) -> bool:
    """Run `gltf-transform meshopt` (quantize + EXT_meshopt_compression).

    The broader `optimize` command is deliberately not used: its join/flatten/
    dedup passes restructure the node graph, which would break the per-instance
    extras.nodeId contract. `meshopt` compresses geometry only.
    """
    command = ["gltf-transform", "meshopt", str(source), str(destination)]
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, timeout=COMPRESS_TIMEOUT_S
        )
    except FileNotFoundError:
        logger.warning("gltf-transform CLI not found; serving uncompressed GLB")
        return False
    except subprocess.TimeoutExpired:
        logger.warning("gltf-transform timed out; serving uncompressed GLB")
        return False

    if result.returncode != 0 or not destination.exists():
        logger.warning(
            "gltf-transform failed (exit %s): %s", result.returncode, result.stderr.strip()
        )
        return False
    return True
