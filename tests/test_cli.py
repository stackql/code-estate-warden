from typer.testing import CliRunner

from repo_warden.cli import app

runner = CliRunner()
COMMANDS = [
    "bootstrap",
    "snapshot",
    "compile-policy",
    "evaluate",
    "report",
    "plan",
    "apply",
    "history",
    "run",
]


def test_help_lists_every_command():
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    for command in COMMANDS:
        assert command in result.output


def test_missing_config_is_a_clean_error():
    result = runner.invoke(app, ["--config", "does-not-exist.toml", "snapshot"])
    assert result.exit_code == 2
    assert "config error" in result.output
