import os, pty, sys, time, select, signal, re, json
# Spike 020: run `claude` in a PTY in a folder, answer the trust prompt, end it, and report.
# Usage: python3 -I trust_probe.py <dir> <keys> <exit|ctrlc|sigterm|sighup|none> [raw-log]
# <keys>: none, or a comma list of enter, down, up, esc, ctrlc, or literal characters such as 1 or y, typed in order, 0.3 s apart.
# Use only on throwaway pitwall-test-* folders. Prints screen lines and the folder's own trust flag.
DROP = ('PITWALL_', 'NPM_', 'CLAUDE_CODE_MESSAGING_')
NAMES = {'INIT_CWD', 'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
         'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT',
         'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_JOB_DIR', 'AI_AGENT',
         'TRACEPARENT', 'TRACESTATE'}
d, answer, end = os.path.realpath(sys.argv[1]), sys.argv[2], sys.argv[3]
raw_log = sys.argv[4] if len(sys.argv) > 4 else None
env = {k: v for k, v in os.environ.items() if not k.upper().startswith(DROP) and k.upper() not in NAMES}
env.update(COLUMNS='120', LINES='40', TERM='xterm-256color', PWD=d)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(d)
    os.execvpe('claude', ['claude'], env)
out = b''
t0 = time.time()
def pump(secs, until=None):
    global out
    end_at = time.time() + secs
    while time.time() < end_at:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try: out += os.read(fd, 65536)
            except OSError: return 'eof'
        if until and re.search(until, text(out)): return 'match'
    return 'timeout'
def text(b):
    s = re.sub(rb'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]', b' ', b)
    return re.sub(r'[ \t]+', ' ', s.decode('utf-8', 'replace'))
def show(label, b):
    lines = [l.strip() for l in text(b).replace('\r', '\n').splitlines() if l.strip()]
    print(f'--- {label} (t={time.time()-t0:.1f}s, {len(lines)} lines)')
    seen = set()
    for l in lines:
        if l not in seen: seen.add(l); print('  ', l[:160])
def trust_flag():
    p = json.load(open(os.path.expanduser('~/.claude.json'))).get('projects', {})
    v = p.get(d); return None if v is None else v.get('hasTrustDialogAccepted')
print('trust before:', trust_flag())
status = None
r = pump(20, r'Enter to confirm|Try "')
mark = len(out)
show(f'first screen ({r})', out)
KEYS = {'ctrlc': b'\x03', 'enter': b'\r', 'down': b'\x1b[B', 'up': b'\x1b[A', 'esc': b'\x1b'}
if answer != 'none':
    pump(1)
    for k in answer.split(','):
        os.write(fd, KEYS.get(k, k.encode())); pump(0.3)
    r = pump(12, r'(\? for shortcuts|Try ")')
    show(f'after keys {answer} ({r})', out[mark:])
    w, st = os.waitpid(pid, os.WNOHANG)
    if w: status = st; print('claude exited on the answer')
    print('trust after answer:', trust_flag())
mark = len(out)
if status is not None: pass
elif end == 'exit':
    for ch in '/exit': os.write(fd, ch.encode()); time.sleep(0.03)
    pump(1); os.write(fd, b'\r')
elif end == 'ctrlc':
    os.write(fd, b'\x03'); pump(0.5); os.write(fd, b'\x03')
elif end == 'sigterm': os.kill(pid, signal.SIGTERM)
elif end == 'sighup': os.kill(pid, signal.SIGHUP)
deadline = time.time() + 10
while status is None and time.time() < deadline:
    pump(0.3)
    w, s = os.waitpid(pid, os.WNOHANG)
    if w: status = s; break
if status is None:
    print('still running after end; SIGKILL'); os.kill(pid, signal.SIGKILL); _, status = os.waitpid(pid, 0)
show(f'after end {end}', out[mark:])
print('exit:', 'code', os.WEXITSTATUS(status) if os.WIFEXITED(status) else None,
      'signal', os.WTERMSIG(status) if os.WIFSIGNALED(status) else None)
print('trust after end:', trust_flag())
proj = os.path.expanduser('~/.claude/projects/' + re.sub(r'[^A-Za-z0-9]', '-', d))
print('transcripts:', sorted(os.listdir(proj)) if os.path.isdir(proj) else 'none')
if raw_log: open(raw_log, 'wb').write(out)
