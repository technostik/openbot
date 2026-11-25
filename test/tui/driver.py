#!/usr/bin/env python3
"""Drives the real opencode TUI in a pseudo-terminal and reads the rendered screen (pyte)."""
import os, pty, sys, time, select, fcntl, termios, struct, json, signal
import pyte

ROWS, COLS = 55, 170
KEY = {"ctrl+p": "\x10", "enter": "\r", "esc": "\x1b", "down": "\x1b[B", "up": "\x1b[A", "ctrl+n": "\x0e", "tab": "\t"}

class Tui:
    def __init__(self, cmd, env, cwd):
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.ByteStream(self.screen)
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(cwd)
            os.execvpe(cmd[0], cmd, {**env, "TERM": "xterm-256color", "COLORTERM": "truecolor", "LINES": str(ROWS), "COLUMNS": str(COLS)})
        self.pid, self.fd = pid, fd
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    def pump(self, seconds=0.3):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if r:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    return
                if not data:
                    return
                self.stream.feed(data)

    def text(self):
        return "\n".join(line.rstrip() for line in self.screen.display)

    def send(self, s, delay=0.04):
        for ch in (KEY.get(s, s) if s in KEY else s):
            os.write(self.fd, ch.encode())
            time.sleep(delay)
        self.pump(0.4)

    def key(self, name):
        os.write(self.fd, KEY[name].encode()); self.pump(0.5)

    def wait_for(self, needle, timeout=25):
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.3)
            if needle in self.text():
                return True
        return False

    def close(self):
        try:
            os.kill(self.pid, signal.SIGTERM)
        except Exception:
            pass

results = []
def check(name, ok, tui=None):
    results.append((name, ok))
    print(("  ok   " if ok else "  FAIL ") + name, flush=True)
    if not ok and tui is not None:
        print("---- screen ----\n" + tui.text() + "\n---- end screen ----", flush=True)

def convs(t, home):
    print("\n[T4] conversations: open the bot's conversation from the inspector; generate a report", flush=True)
    t.pump(3)
    check("sidebar lists the seeded bot", t.wait_for("@seedbot", 40), t)
    t.key("ctrl+p"); t.send("diagnostic report")
    if os.environ.get("DRIVER_DEBUG"): print("---- palette ----\n" + t.text() + "\n----", flush=True)
    t.key("enter")
    if os.environ.get("DRIVER_DEBUG"): print("---- after enter ----\n" + t.text() + "\n----", flush=True)
    check("report dialog says where the report was written", t.wait_for("Report written", 30) and "openbot-report-" in t.text(), t)
    t.key("esc")
    reports = os.path.join(home, "reports")
    files = os.listdir(reports) if os.path.isdir(reports) else []
    check("report file exists and has the expected sections", bool(files) and "# openbot diagnostic report" in open(os.path.join(reports, files[0])).read() and "## Bot `seedbot`" in open(os.path.join(reports, files[0])).read(), t)
    t.pump(1)
    t.key("ctrl+p"); t.send("Bots: inspect"); t.key("enter")
    check("bots dialog opens", t.wait_for("@seedbot", 10), t)
    t.key("enter")
    check("bot menu opens", t.wait_for("Conversations", 10), t)
    t.send("Conversations"); t.key("enter")
    check("conversation list shows where the bot was used", t.wait_for("Used from session", 10), t)
    t.key("enter")
    check("opening it navigates to the bot's own session, showing the exchange", t.wait_for("seed reply from bot", 20), t)

def main():
    base, pw, session, project, home = sys.argv[1:6]
    mode = sys.argv[6] if len(sys.argv) > 6 else "basic"
    debug = os.environ.get("OPENBOT_DEBUG") == "1"
    env = dict(os.environ); env["OPENCODE_SERVER_PASSWORD"] = pw
    t = Tui([os.environ["OPENCODE_BIN"], "--server", base, "--session", session, project], env, project)
    try:
        if mode == "convs":
            convs(t, home)
            return finish(t)
        t.pump(3)
        ok = t.wait_for("Bots (0)", 40)
        check("TUI started and the openbot sidebar section is rendered ('Bots (0)')", ok, t)
        check("sidebar tells how to create a bot", "Create bot" in t.text(), t)

        print("\n[T1] Ctrl+P palette lists the openbot commands", flush=True)
        t.key("ctrl+p"); t.send("bot")
        check("palette shows 'Create bot'", t.wait_for("Create bot", 10), t)
        check("palette shows 'Bots: inspect'", t.wait_for("Bots: inspect", 10), t)
        if debug:
            check("palette shows the debug commands (debug on)", t.wait_for("Bots: diagnose", 10) and t.wait_for("generate diagnostic report", 10), t)

        print("\n[T2] create a bot through the dialogs", flush=True)
        t.key("esc"); t.pump(0.5)
        t.key("ctrl+p"); t.send("Create bot"); t.key("enter")
        check("name dialog opens", t.wait_for("Create bot: name", 10), t)
        t.send("tuibot"); t.key("enter")
        check("role dialog opens", t.wait_for("Create bot: role", 10), t)
        t.send("You are tuibot. Answer briefly."); t.key("enter")
        check("model dialog opens with the default option", t.wait_for("Default model", 10), t)
        t.key("enter")
        check("working directory dialog opens", t.wait_for("working directory", 10), t)
        t.key("enter")
        done = False
        for _ in range(40):
            t.pump(0.3)
            if os.path.exists(os.path.join(home, "bots", "tuibot", "bot.json")):
                done = True; break
        check("bot.json and system.md were created", done and os.path.exists(os.path.join(home, "bots", "tuibot", "system.md")), t)
        check("sidebar count updates to 'Bots (1)'", t.wait_for("Bots (1)", 15), t)
        check("sidebar lists the bot with its model", t.wait_for("@tuibot  default model", 5), t)

        print("\n[T3] inspect: master prompt, working directory, conversations", flush=True)
        t.key("ctrl+p"); t.send("Bots: inspect"); t.key("enter")
        check("bots list dialog shows the bot", t.wait_for("@tuibot", 10) and "Bots" in t.text(), t)
        t.key("enter")
        check("bot menu opens with its sections", t.wait_for("Master prompt", 10) and "Working directory" in t.text() and "Conversations" in t.text(), t)
        t.send("Master prompt"); t.key("enter")
        check("master prompt submenu", t.wait_for("master prompt", 10), t)
        t.key("enter")  # View
        check("view shows the prompt text and the system.md path", t.wait_for("Answer briefly", 10) and "system.md" in t.text(), t)
        t.key("esc"); t.key("esc"); t.pump(0.5)
        if debug:
            t.key("ctrl+p"); t.send("Bots: diagnose"); t.key("enter")
            check("diagnose dialog shows results", t.wait_for("Working directory is ready", 20) or t.wait_for("openbot", 5), t)
            t.key("esc")
    finally:
        t.close()
    finish(t)

def finish(t):
    t.close()
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    sys.exit(1 if failed else 0)

main()
