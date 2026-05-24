# /// script
# requires-python = ">=3.12"
# dependencies = ["mcp[cli]", "flask"]
# ///

import glob
import os
import shutil
import subprocess
import tempfile
import threading
from datetime import date

from flask import Flask, jsonify, request
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("job-automation")
app = Flask(__name__)


def _esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _latest_resume() -> str | None:
    resumes_dir = os.path.expanduser("~/Desktop/Resumes")
    pdfs = sorted(glob.glob(os.path.join(resumes_dir, "*.pdf")), key=os.path.getmtime, reverse=True)
    return pdfs[0] if pdfs else None


def _draft_mail(recipient: str, subject: str, body: str, pdf_path: str) -> None:
    script = f"""\
tell application "Mail"
    set theFile to POSIX file "{pdf_path}"
    set msg to make new outgoing message with properties \\
        {{subject:"{_esc(subject)}", content:"{_esc(body)}", visible:true}}
    tell msg
        set newRecipient to make new to recipient at end of to recipients
        set address of newRecipient to "{_esc(recipient)}"
        make new attachment with properties {{file name:theFile}}
    end tell
    activate
end tell
"""
    with tempfile.NamedTemporaryFile(suffix=".applescript", mode="w", delete=False) as f:
        f.write(script)
        script_path = f.name
    try:
        subprocess.run(["osascript", script_path], capture_output=True)
    finally:
        os.unlink(script_path)


# ── HTTP endpoint for Chrome extension ─────────────────────────
@app.route("/compose", methods=["POST", "OPTIONS"])
def compose():
    if request.method == "OPTIONS":
        res = jsonify({})
        res.headers["Access-Control-Allow-Origin"] = "*"
        res.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return res, 200

    data = request.get_json(force=True)
    recipient = data.get("recipient", "")
    subject   = data.get("subject", "")
    body      = data.get("body", "")

    pdf_path = _latest_resume()
    if not pdf_path:
        res = jsonify({"ok": False, "error": "No resume found in ~/Desktop/Resumes/"})
        res.headers["Access-Control-Allow-Origin"] = "*"
        return res, 404

    _draft_mail(recipient, subject, body, pdf_path)

    res = jsonify({"ok": True, "pdf": pdf_path})
    res.headers["Access-Control-Allow-Origin"] = "*"
    return res


# ── MCP tool ────────────────────────────────────────────────────
@mcp.tool()
def save_and_draft(
    latex: str,
    email_subject: str,
    email_body: str,
    company_name: str,
) -> str:
    """
    Compile the LaTeX resume to PDF, save it to ~/Desktop/Resumes/,
    and open an Apple Mail draft with the subject, body, and PDF attached.
    """
    resumes_dir = os.path.expanduser("~/Desktop/Resumes")
    os.makedirs(resumes_dir, exist_ok=True)

    today = date.today().strftime("%Y-%m-%d")
    safe_name = (
        "".join(c for c in company_name if c.isalnum() or c in "-_").strip()
        or "company"
    )
    pdf_path = os.path.join(resumes_dir, f"resume_{safe_name}_{today}.pdf")

    with tempfile.TemporaryDirectory() as tmpdir:
        tex_path = os.path.join(tmpdir, "resume.tex")
        with open(tex_path, "w") as f:
            f.write(latex)

        result = subprocess.run(
            ["tectonic", "resume.tex"],
            cwd=tmpdir,
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            tail = (result.stdout + result.stderr)[-800:]
            return f"tectonic failed:\n{tail}"

        compiled = os.path.join(tmpdir, "resume.pdf")
        if not os.path.exists(compiled):
            return "tectonic ran but produced no PDF."

        shutil.copy(compiled, pdf_path)

    _draft_mail("", email_subject, email_body, pdf_path)
    return f"Saved {pdf_path} and opened Mail draft."


if __name__ == "__main__":
    # Run Flask on port 27182 in a background thread
    thread = threading.Thread(
        target=lambda: app.run(host="127.0.0.1", port=27182, debug=False),
        daemon=True,
    )
    thread.start()
    mcp.run()
