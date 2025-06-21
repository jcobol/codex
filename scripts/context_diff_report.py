#!/usr/bin/env python3
"""Generate an HTML report of the largest prompts from the token log CSV."""

import argparse
from pathlib import Path
import base64
from io import BytesIO

import pandas as pd
import matplotlib.pyplot as plt


def main() -> int:
    parser = argparse.ArgumentParser(description="Create token usage report")
    parser.add_argument("csv", type=Path, help="Input token CSV")
    parser.add_argument("output", type=Path, help="Output HTML file")
    args = parser.parse_args()

    df = pd.read_csv(args.csv, names=["model", "prompt_tokens", "completion_tokens"])
    df["total"] = df["prompt_tokens"] + df["completion_tokens"]
    top = df.sort_values("total", ascending=False).head(20)

    fig, ax = plt.subplots(figsize=(10, 6))
    top.plot.barh(ax=ax, x="model", y="total")
    ax.invert_yaxis()
    ax.set_xlabel("Total Tokens")
    ax.set_title("Top 20 Largest Prompts")

    buf = BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format="png")
    encoded = base64.b64encode(buf.getvalue()).decode()

    html = f"<html><body><h1>Top 20 Largest Prompts</h1><img src='data:image/png;base64,{encoded}'/></body></html>"
    args.output.write_text(html)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
