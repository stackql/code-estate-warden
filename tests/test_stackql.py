import subprocess

import pytest

from repo_warden import stackql


@pytest.fixture
def fake_stackql(monkeypatch: pytest.MonkeyPatch):
    """Replace the binary with canned stdout and stderr, and capture the command line."""
    calls: list[list[str]] = []

    def fake(stdout: str = "", stderr: str = "") -> list[list[str]]:
        def run(cmd: list[str], **_: object) -> subprocess.CompletedProcess[str]:
            calls.append(cmd)
            return subprocess.CompletedProcess(cmd, 0, stdout, stderr)

        monkeypatch.setattr(stackql, "binary", lambda: "stackql")
        monkeypatch.setattr(subprocess, "run", run)
        return calls

    return fake


def test_execute_returns_rows(fake_stackql):
    fake_stackql(stdout='[{"login":"octocat"}]')
    assert stackql.execute("SELECT login FROM github.users.users") == [{"login": "octocat"}]


def test_execute_raises_on_stderr_with_no_rows(fake_stackql):
    fake_stackql(stderr="cannot resolve service with key = 'nope'")
    with pytest.raises(stackql.StackQLError, match="cannot resolve service"):
        stackql.execute("SELECT x FROM github.nope.nope")


def test_execute_reads_the_token_from_the_named_variable(fake_stackql):
    calls = fake_stackql(stdout="[]")
    stackql.execute("SELECT 1", token_var=stackql.WRITE_TOKEN_VAR)
    auth = calls[0][calls[0].index("--auth") + 1]
    assert stackql.WRITE_TOKEN_VAR in auth
    assert stackql.READ_TOKEN_VAR not in auth


def test_execute_without_binary(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(stackql, "binary", lambda: None)
    with pytest.raises(stackql.StackQLError, match="make bootstrap"):
        stackql.execute("SHOW PROVIDERS")


def test_pull_provider_accepts_success_on_stderr(monkeypatch: pytest.MonkeyPatch):
    def run(cmd: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        if cmd[-1].startswith("REGISTRY PULL"):
            return subprocess.CompletedProcess(cmd, 0, "", "github provider successfully installed")
        return subprocess.CompletedProcess(cmd, 0, '[{"name":"github","version":"v1"}]', "")

    monkeypatch.setattr(stackql, "binary", lambda: "stackql")
    monkeypatch.setattr(subprocess, "run", run)
    assert stackql.pull_provider() == "v1"


def test_provider_version(fake_stackql):
    fake_stackql(stdout='[{"name":"github","version":"v1"}]')
    assert stackql.provider_version() == "v1"


def test_provider_version_when_not_installed(fake_stackql):
    fake_stackql(stdout='[{"name":"stackql_preview","version":"internal"}]')
    with pytest.raises(stackql.StackQLError, match="not installed"):
        stackql.provider_version()
