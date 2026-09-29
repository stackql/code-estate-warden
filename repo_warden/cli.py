"""repo-warden command line entrypoint."""

from pathlib import Path
from typing import Annotated

import typer
from dotenv import load_dotenv
from pydantic import ValidationError
from rich.console import Console

from repo_warden import stackql
from repo_warden.config import load_config

app = typer.Typer(
    no_args_is_help=True,
    help="Security posture audit and remediation for GitHub organizations.",
)
console = Console()


@app.callback()
def main(
    ctx: typer.Context,
    config: Annotated[Path, typer.Option("--config", "-c", help="Path to the config file.")] = Path(
        "repo-warden.toml"
    ),
) -> None:
    load_dotenv()
    try:
        ctx.obj = load_config(config)
    except (OSError, ValidationError) as e:
        console.print(f"[red]config error[/red] {config}: {e}")
        raise typer.Exit(2) from e


def _stub(name: str) -> None:
    console.print(f"{name}: not implemented yet")
    raise typer.Exit(1)


@app.command()
def bootstrap() -> None:
    """Check the stackql binary (download it if missing) and pull the github provider."""
    try:
        exe = stackql.binary() or stackql.install()
        version = stackql.pull_provider()
    except (OSError, stackql.StackQLError) as e:
        console.print(f"[red]bootstrap failed[/red] {e}")
        raise typer.Exit(1) from e
    console.print(f"stackql binary: {exe}")
    console.print(f"{stackql.PROVIDER} provider: {version}")


@app.command()
def snapshot() -> None:
    """Enumerate orgs, repos and settings with StackQL and write a snapshot to SQLite."""
    _stub("snapshot")


@app.command()
def compile_policy() -> None:
    """Compile a policy prompt into checks.yaml."""
    _stub("compile-policy")


@app.command()
def evaluate() -> None:
    """Run the checks in the manifest against a snapshot."""
    _stub("evaluate")


@app.command()
def report() -> None:
    """Render findings as a terminal table, markdown, JSON or a job summary."""
    _stub("report")


@app.command()
def plan() -> None:
    """Turn findings into a change set. Nothing is applied."""
    _stub("plan")


@app.command()
def apply() -> None:
    """Apply a change set. Requires --apply and a write token."""
    _stub("apply")


@app.command()
def history() -> None:
    """Diff two runs and show newly failing and newly passing checks."""
    _stub("history")


@app.command()
def run() -> None:
    """snapshot -> evaluate -> report -> plan."""
    _stub("run")
