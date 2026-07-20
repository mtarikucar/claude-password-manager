/**
 * Tests for the keystroke-injection layer (src/injector.ts).
 *
 * These cover the PURE, deterministic pieces — per-OS escaping, the spawn spec,
 * and the reveal-gating flag — plus the spawn wiring via an injected fake so no
 * real keystrokes are ever sent from the test suite. The actual OS auto-type is
 * an integration side-effect verified manually on a desktop.
 *
 * Run with `tsx test/injector.test.ts`.
 */
import {
  escapeSendKeys,
  appleScriptKeystroke,
  injectorSpec,
  injectKeystrokes,
  shouldExposeReveal,
  type SpawnLike,
} from "../src/injector.js";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}

async function expectReject(name: string, p: Promise<unknown>) {
  try {
    await p;
    failed++;
    console.error(`  FAIL ${name} (expected rejection)`);
  } catch {
    passed++;
    console.log(`  ok   ${name}`);
  }
}

/** A fake child-process spawner that records what it was asked to type. */
function makeFakeSpawn(opts: { exitCode?: number; error?: Error } = {}) {
  const calls: { cmd: string; args: string[]; stdin: string }[] = [];
  const spawnFn: SpawnLike = (cmd, args) => {
    let buf = "";
    const handlers: Record<string, (a: unknown) => void> = {};
    return {
      stdin: {
        write(s: string) {
          buf += s;
        },
        end() {
          calls.push({ cmd, args, stdin: buf });
          queueMicrotask(() => {
            if (opts.error) handlers["error"]?.(opts.error);
            else handlers["close"]?.(opts.exitCode ?? 0);
          });
        },
      },
      on(ev: string, cb: (a: unknown) => void) {
        handlers[ev] = cb;
      },
    };
  };
  return { spawnFn, calls };
}

async function main() {
  // --- escapeSendKeys: literal text is left alone --------------------------
  check("sendkeys passes plain text through", escapeSendKeys("hunter2") === "hunter2");

  // --- escapeSendKeys: SendKeys metacharacters get brace-wrapped ------------
  check("sendkeys escapes plus", escapeSendKeys("a+b") === "a{+}b");
  check("sendkeys escapes caret/percent/tilde", escapeSendKeys("^%~") === "{^}{%}{~}");
  check("sendkeys escapes parens and brackets", escapeSendKeys("()[]") === "{(}{)}{[}{]}");
  check("sendkeys escapes braces", escapeSendKeys("{}") === "{{}{}}");
  check(
    "sendkeys escapes a realistic password without double-escaping",
    escapeSendKeys("P@ss+w{0}rd") === "P@ss{+}w{{}0{}}rd",
  );

  // --- appleScriptKeystroke: builds an escaped keystroke command ------------
  const as = appleScriptKeystroke('a"b\\c');
  check("applescript keeps keystroke verb", as.includes("keystroke"));
  check("applescript escapes double quotes", as.includes('a\\"b'));
  check("applescript escapes backslashes", as.includes("b\\\\c"));

  // --- injectorSpec: right tool + payload per platform ---------------------
  const win = injectorSpec("win32", "a+b");
  check("win32 uses powershell", win.cmd === "powershell");
  check("win32 stdin is sendkeys-escaped", win.stdin === "a{+}b");
  const mac = injectorSpec("darwin", "sec");
  check("darwin uses osascript", mac.cmd === "osascript");
  check("darwin stdin is an applescript", mac.stdin.includes("keystroke"));
  const lin = injectorSpec("linux", "sec+ret");
  check("linux uses xdotool", lin.cmd === "xdotool");
  check("linux reads literal from stdin (no escaping)", lin.stdin === "sec+ret");
  check("linux stdin flag present", lin.args.includes("--file"));
  let threw = false;
  try {
    injectorSpec("plan9" as unknown as "linux", "x");
  } catch {
    threw = true;
  }
  check("unsupported platform throws", threw);

  // --- injectKeystrokes: wiring, via a fake spawn (no real typing) ----------
  {
    const { spawnFn, calls } = makeFakeSpawn({ exitCode: 0 });
    await injectKeystrokes("s3cret", { platform: "win32", spawnFn });
    check("inject spawned exactly once", calls.length === 1);
    check("inject used the platform command", calls[0].cmd === "powershell");
    check("inject wrote the escaped secret to stdin", calls[0].stdin === "s3cret");
  }
  {
    const { spawnFn } = makeFakeSpawn({ exitCode: 1 });
    await expectReject(
      "inject rejects on nonzero exit",
      injectKeystrokes("x", { platform: "linux", spawnFn }),
    );
  }
  {
    const { spawnFn } = makeFakeSpawn({ error: new Error("no xdotool") });
    await expectReject(
      "inject rejects on spawn error",
      injectKeystrokes("x", { platform: "linux", spawnFn }),
    );
  }

  // --- shouldExposeReveal: plaintext get_credential is opt-in --------------
  check("reveal is off by default", shouldExposeReveal({}) === false);
  check("reveal off for other values", shouldExposeReveal({ CCPM_ALLOW_REVEAL: "0" }) === false);
  check("reveal on when explicitly enabled", shouldExposeReveal({ CCPM_ALLOW_REVEAL: "1" }) === true);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
