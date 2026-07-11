from typing import Literal

ErrorCode = Literal[
    "READ_FAILED",
    "TESSELLATION_FAILED",
    "UPLOAD_FAILED",
    "INVALID_INPUT",
    "LIMIT_EXCEEDED",
    "BUSY",
]


class ConvertError(Exception):
    def __init__(self, code: ErrorCode, message: str, status_code: int = 500) -> None:
        super().__init__(message)
        self.code: ErrorCode = code
        self.message = message
        self.status_code = status_code
