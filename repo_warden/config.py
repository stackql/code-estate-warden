"""Load and validate repo-warden.toml."""

import tomllib
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Severity = Literal["high", "medium", "low"]
RepoName = Annotated[str, StringConstraints(pattern=r"^[^/\s]+/[^/\s]+$")]


class Config(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enterprise: str
    orgs: list[str] = Field(min_length=1)
    exclude_repos: list[RepoName] = []
    model: str
    issue_label: str = "repo-warden"
    database: Path = Path("repo-warden.db")
    severity: dict[str, Severity] = {}


def load_config(path: Path) -> Config:
    with path.open("rb") as f:
        return Config.model_validate(tomllib.load(f))
