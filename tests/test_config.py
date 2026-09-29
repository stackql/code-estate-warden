from pathlib import Path

import pytest
from pydantic import ValidationError

from repo_warden.config import Config, load_config

ROOT = Path(__file__).parent.parent
MINIMAL = {"enterprise": "acme", "orgs": ["acme"], "model": "some-model"}


def test_shipped_config_is_valid():
    config = load_config(ROOT / "repo-warden.toml")
    assert config.orgs
    assert config.issue_label == "repo-warden"


def test_defaults():
    config = Config.model_validate(MINIMAL)
    assert config.exclude_repos == []
    assert config.database == Path("repo-warden.db")


@pytest.mark.parametrize(
    "override",
    [
        {"orgs": []},
        {"exclude_repos": ["no-org-prefix"]},
        {"severity": {"secret_scanning": "critical"}},
        {"unknown_key": 1},
    ],
)
def test_rejects_invalid(override: dict[str, object]):
    with pytest.raises(ValidationError):
        Config.model_validate(MINIMAL | override)
