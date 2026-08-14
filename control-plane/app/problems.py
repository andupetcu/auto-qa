"""RFC 9457 problem+json error responses."""
from fastapi import Request
from fastapi.responses import JSONResponse

PROBLEM_MEDIA_TYPE = "application/problem+json"


class ProblemException(Exception):
    """Raise from a dependency or route handler to short-circuit with a problem+json response."""

    def __init__(self, status: int, title: str, detail: str | None = None, **extra):
        super().__init__(detail or title)
        self.status = status
        self.title = title
        self.detail = detail
        self.extra = extra


def problem_response(status: int, title: str, detail: str | None = None, **extra) -> JSONResponse:
    content = {"title": title, "status": status}
    if detail is not None:
        content["detail"] = detail
    content.update(extra)
    return JSONResponse(status_code=status, content=content, media_type=PROBLEM_MEDIA_TYPE)


def register_problem_handlers(app) -> None:
    @app.exception_handler(ProblemException)
    async def _handle_problem(request: Request, exc: ProblemException):
        return problem_response(exc.status, exc.title, exc.detail, **exc.extra)
