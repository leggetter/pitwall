import os, pty, sys, time, select, signal, re
# Spike 019: type /remote-control into a background session through `claude attach`.
# Usage: python3 -I attach_rc.py <short id>. Use only on a throwaway pitwall-test-* session.
sid = sys.argv[1]
pid, fd = pty.fork()
if pid == 0:
    os.environ['COLUMNS'] = '120'; os.environ['LINES'] = '40'
    os.execvp('claude', ['claude', 'attach', sid])
out = b''
def pump(secs):
    global out
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try: out += os.read(fd, 65536)
            except OSError: return
pump(4)
for ch in '/remote-control': os.write(fd, ch.encode()); time.sleep(0.03)
pump(1)
os.write(fd, b'\r')
pump(8)
os.kill(pid, signal.SIGHUP)
text = re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07', b' ', out).decode('utf-8', 'replace')
lines = [l.strip() for l in text.splitlines() if re.search(r'(?i)remote|control|connect|claude\.ai|bridge', l)]
print('\n'.join(re.sub(r'\s+', ' ', l)[:200] for l in lines[-12:]))
