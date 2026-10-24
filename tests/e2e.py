"""End-to-end check in Chromium with a fake microphone that plays a WAV file.

Runs the real app against the real APIs: mic → worklet → Scribe Realtime → translation.
Midway it drops the socket to exercise reconnection.

    EL_KEY=... GM_KEY=... python tests/e2e.py tests/test.wav [seconds]

Screenshots and a JSON log go to tests/out/.
"""
import functools
import http.server
import json
import os
import sys
import threading
import time
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'tests' / 'out'
wav = Path(sys.argv[1]).resolve()
seconds = int(sys.argv[2]) if len(sys.argv) > 2 else 75


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    httpd.RequestHandlerClass.log_message = lambda *a: None
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd.server_address[1]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    port = serve()
    keys = urllib.parse.urlencode({k: v for k, v in (('el', os.environ.get('EL_KEY', '')),
                                                      ('gm', os.environ.get('GM_KEY', ''))) if v})
    log = {'console': [], 'sent_chunks': 0, 'server': [], 'samples': []}

    with sync_playwright() as p:
        browser = p.chromium.launch(args=[
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            f'--use-file-for-fake-audio-capture={wav}%noloop',
            '--autoplay-policy=no-user-gesture-required',
        ])
        ctx = browser.new_context(**p.devices['iPhone 13'], permissions=['microphone'])
        page = ctx.new_page()
        page.on('console', lambda m: log['console'].append(f'{m.type}: {m.text}'))
        page.on('pageerror', lambda e: log['console'].append(f'pageerror: {e}'))

        def on_ws(ws):
            def sent(payload):
                if '"input_audio_chunk"' in payload:
                    log['sent_chunks'] += 1
                    if '"previous_text"' in payload:
                        log['server'].append({'previous_text': json.loads(payload)['previous_text']})
            def received(payload):
                d = json.loads(payload)
                if d['message_type'] != 'partial_transcript':
                    log['server'].append({k: d.get(k) for k in ('message_type', 'text', 'error') if d.get(k)})
            ws.on('framesent', sent)
            ws.on('framereceived', received)
        page.on('websocket', on_ws)

        page.goto(f'http://127.0.0.1:{port}/#{keys}')
        assert '#' not in page.url, 'keys left in the URL hash'
        page.screenshot(path=str(OUT / '0_idle.png'))
        page.click('#main-btn')

        t0 = time.time()
        dropped = False
        shot_live = False
        while time.time() - t0 < seconds:
            time.sleep(1)
            el = int(time.time() - t0)
            state = page.evaluate("""() => ({
                status: document.getElementById('status-text').textContent,
                engine: document.getElementById('engine').textContent,
                live_en: document.querySelector('#live .en').textContent,
                live_ko: document.querySelector('#live .ko').textContent,
                segs: document.querySelectorAll('#segments .seg').length,
            })""")
            log['samples'].append({'t': el, **state})
            if state['live_ko'] and not shot_live:
                page.screenshot(path=str(OUT / '1_live_provisional.png'))
                shot_live = True
            if el >= 30 and not dropped:
                page.evaluate('window.__lc.dropSocket()')
                dropped = True
                log['server'].append({'event': f'socket dropped by test at {el}s'})

        page.screenshot(path=str(OUT / '2_running.png'))
        page.click('#main-btn')
        time.sleep(4)
        page.screenshot(path=str(OUT / '3_stopped.png'))
        log['segments'] = page.evaluate("""() => [...document.querySelectorAll('#segments > div')].map(d =>
            d.classList.contains('divider') ? {divider: d.textContent} :
            {ko: d.querySelector('.ko').textContent, en: d.querySelector('.en').textContent})""")
        log['stored'] = len(json.loads(page.evaluate("localStorage.getItem('lc_segments') || '[]'")))

        # A reload must bring the captions back.
        page.reload()
        log['restored'] = page.evaluate("document.querySelectorAll('#segments .seg').length")

        # A setup link pasted into the key field fills both keys.
        page.click('#settings-btn')
        page.fill('#el-key', 'https://example.org/LiveCaption/#el=EL_TEST&gm=GM_TEST')
        page.click('#save-btn')
        log['paste'] = page.evaluate("[localStorage.getItem('lc_el_key'), localStorage.getItem('lc_gm_key')]")
        browser.close()

    (OUT / 'log.json').write_text(json.dumps(log, ensure_ascii=False, indent=1))
    print(json.dumps({k: log[k] for k in ('sent_chunks', 'stored', 'restored', 'paste')}, ensure_ascii=False))
    for s in log['segments']:
        print(s)
    print('--- server events')
    for e in log['server']:
        print(e)
    print('--- console')
    for c in log['console']:
        print(c)


if __name__ == '__main__':
    main()
