# /// script
# requires-python = ">=3.12"
# dependencies = ["flask"]
# ///

import glob
import os
import subprocess
import tempfile

from flask import Flask, jsonify, request

app = Flask(__name__)


def _as_str(s: str) -> str:
    """Convert a Python string to a valid AppleScript string expression."""
    if not s:
        return '""'
    lines = s.split('\n')
    def escape_line(line):
        parts = line.split('"')
        return ' & quote & '.join(f'"{p}"' for p in parts)
    chunks = [escape_line(l) for l in lines]
    return ' & return & '.join(chunks)


def _latest_resume() -> str | None:
    resumes_dir = os.path.expanduser("~/Desktop/Resumes")
    pdfs = sorted(
        glob.glob(os.path.join(resumes_dir, "*.pdf")),
        key=os.path.getmtime,
        reverse=True,
    )
    return pdfs[0] if pdfs else None


@app.route("/compose", methods=["POST", "OPTIONS"])
def compose():
    if request.method == "OPTIONS":
        res = jsonify({})
        res.headers["Access-Control-Allow-Origin"] = "*"
        res.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return res, 200

    data      = request.get_json(force=True)
    recipient = data.get("recipient", "")
    subject   = data.get("subject", "")
    body      = data.get("body", "")

    pdf_path = _latest_resume()
    if not pdf_path:
        res = jsonify({"ok": False, "error": "No resume found in ~/Desktop/Resumes/"})
        res.headers["Access-Control-Allow-Origin"] = "*"
        return res, 404

    script = f"""\
tell application "Mail"
    set theFile to POSIX file "{pdf_path}"
    set theSubject to {_as_str(subject)}
    set theBody to {_as_str(body)}
    set theRecipient to {_as_str(recipient)}
    set msg to make new outgoing message with properties {{subject:theSubject, content:theBody, visible:true}}
    tell msg
        make new to recipient with properties {{address:theRecipient}}
        make new attachment with properties {{file name:theFile}}
    end tell
    activate
end tell
"""

    with tempfile.NamedTemporaryFile(suffix=".applescript", mode="w", delete=False) as f:
        f.write(script)
        script_path = f.name

    try:
        r = subprocess.run(["osascript", script_path], capture_output=True, text=True)
        if r.returncode != 0:
            print("osascript error:", r.stderr, flush=True)
    finally:
        os.unlink(script_path)

    res = jsonify({"ok": True, "pdf": pdf_path})
    res.headers["Access-Control-Allow-Origin"] = "*"
    return res


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=27182, debug=False)
