#!/usr/bin/env python3
from http.server import HTTPServer, BaseHTTPRequestHandler
import base64, json, os, subprocess, threading, time

class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        if self.path == '/resumes':
            d = os.path.expanduser('~/Desktop/Resumes')
            files = []
            if os.path.isdir(d):
                pdfs = [f for f in os.listdir(d) if f.lower().endswith('.pdf')]
                pdfs.sort(key=lambda f: os.path.getmtime(os.path.join(d, f)), reverse=True)
                files = [{'name': f, 'path': os.path.join(d, f)} for f in pdfs]
            body = json.dumps(files).encode()
            self.send_response(200)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        data = json.loads(self.rfile.read(length))
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        if self.path == '/pdftext':
            path = data.get('path', '')
            text = ''
            if path and os.path.exists(path):
                try:
                    pdftotext = '/opt/homebrew/bin/pdftotext' if os.path.exists('/opt/homebrew/bin/pdftotext') else 'pdftotext'
                    out = subprocess.run([pdftotext, '-layout', path, '-'],
                                         capture_output=True, text=True, timeout=15)
                    text = out.stdout
                except Exception as e:
                    text = ''
            self.wfile.write(json.dumps({'text': text}).encode())
        elif self.path == '/save':
            raw = data.get('data', '')
            fname = data.get('filename', 'resume.pdf')
            dst = os.path.join(os.path.expanduser('~/Desktop/Resumes'), fname)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if raw.startswith('data:'):
                pdf_bytes = base64.b64decode(raw.split(',', 1)[1])
            else:
                pdf_bytes = raw.encode('latin-1')
            with open(dst, 'wb') as f:
                f.write(pdf_bytes)
        elif self.path == '/log':
            with open('/tmp/swifthire.log', 'a') as f:
                f.write(time.strftime('%H:%M:%S ') + data.get('line', '') + '\n')
        elif self.path == '/rename':
            src = data.get('src', '')
            dst = data.get('dst', '')
            if src and dst and os.path.exists(src):
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                os.replace(src, dst)
        else:
            threading.Thread(target=compose, args=(data,), daemon=True).start()

    def log_message(self, *args): pass

def compose(data):
    to_addr    = data.get('to', '')
    subject    = data.get('subject', '').replace('\\', '\\\\').replace('"', '\\"')
    html_body  = data.get('html_body', '')
    attachment = data.get('attachment', '')

    html_file   = '/tmp/swifthire_body.html'
    script_file = '/tmp/swifthire_compose.applescript'

    with open(html_file, 'w', encoding='utf-8') as f:
        f.write(
            '<html><body style="font-family:Helvetica,Arial,sans-serif;'
            'font-size:14px;line-height:1.6;color:#000">'
            f'{html_body}</body></html>'
        )

    if not attachment or not os.path.exists(attachment):
        resumes_dir = os.path.expanduser('~/Desktop/Resumes')
        pdfs = [os.path.join(resumes_dir, f) for f in os.listdir(resumes_dir) if f.endswith('.pdf')]
        attachment = max(pdfs, key=os.path.getmtime) if pdfs else ''

    attach_line = ''
    if attachment and os.path.exists(attachment):
        attach_line = (
            f'make new attachment with properties '
            f'{{file name:(POSIX file "{attachment}") as alias}}'
        )

    script = f'''set htmlContent to do shell script "cat {html_file}"
tell application "Mail"
    set newMsg to make new outgoing message with properties {{visible:true, subject:"{subject}", html content:htmlContent}}
    tell newMsg
        make new to recipient with properties {{address:"{to_addr}"}}
        {attach_line}
    end tell
    activate
end tell
'''
    with open(script_file, 'w', encoding='utf-8') as f:
        f.write(script)

    result = subprocess.run(['osascript', script_file], capture_output=True, text=True)
    if result.returncode != 0:
        print(f'osascript error: {result.stderr}', flush=True)

HTTPServer(('127.0.0.1', 9875), Handler).serve_forever()
