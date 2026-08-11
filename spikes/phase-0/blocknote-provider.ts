/**
 * Spike 2 — BlockNote collaboration provider shape and headless construction.
 *
 * Questions:
 * 1. What is the minimal CollaborationOptions shape for the installed version?
 * 2. Which provider/awareness methods are called at construction time?
 * 3. Does awareness state leak into the ydoc update log (it must not)?
 * 4. Can BlockNoteEditor be constructed headlessly in Node (no DOM)?
 *
 * Throwaway script. Not production code.
 */

import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";

// ---------------------------------------------------------------------------
// Instrumentation: wrap Awareness to log what BlockNote calls
// ---------------------------------------------------------------------------

function makeInstrumentedAwareness(doc: Y.Doc): {
  awareness: Awareness;
  calls: string[];
} {
  const real = new Awareness(doc);
  const calls: string[] = [];

  // Proxy to intercept method calls
  const proxied = new Proxy(real, {
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver);
      if (typeof val === "function" && typeof prop === "string") {
        return (...args: unknown[]) => {
          const preview = args
            .map((a) =>
              typeof a === "string" ? `"${a}"` : typeof a === "function" ? "<fn>" : JSON.stringify(a)
            )
            .join(", ");
          calls.push(`awareness.${prop}(${preview})`);
          return (val as Function).apply(target, args);
        };
      }
      return val;
    },
  });

  return { awareness: proxied as Awareness, calls };
}

// ---------------------------------------------------------------------------
// Instrumentation: wrap a provider object to log what BlockNote calls
// ---------------------------------------------------------------------------

function makeInstrumentedProvider(awareness: Awareness): {
  provider: { awareness: Awareness; synced: boolean };
  calls: string[];
} {
  const calls: string[] = [];
  const provider = new Proxy(
    { awareness, synced: true },
    {
      get(target, prop) {
        const val = target[prop as keyof typeof target];
        if (typeof val === "function" && typeof prop === "string") {
          return (...args: unknown[]) => {
            calls.push(`provider.${prop}(${args.map(String).join(", ")})`);
            return (val as Function).apply(target, args);
          };
        }
        if (typeof prop === "string") {
          calls.push(`provider.${prop} accessed`);
        }
        return val;
      },
    }
  );
  return { provider, calls };
}

// ---------------------------------------------------------------------------
// Test 1: Can BlockNoteEditor.create() run without a DOM in Node?
// ---------------------------------------------------------------------------

console.log("=".repeat(70));
console.log("Spike 2 — BlockNote collaboration provider");
console.log("=".repeat(70));

console.log("\n--- Test 1: Headless construction (no DOM) ---\n");
console.log("globalThis.window:", typeof (globalThis as any).window);
console.log("globalThis.document:", typeof (globalThis as any).document);

const doc1 = new Y.Doc({ gc: false });
const fragment1 = doc1.getXmlFragment("blocks");

let editor: BlockNoteEditor | null = null;
let constructionError: Error | null = null;

try {
  editor = BlockNoteEditor.create(
    withCollaboration({
      collaboration: {
        fragment: fragment1,
        user: { name: "local", color: "#ff0000" },
        // No provider — omitted entirely
      },
    })
  );
  console.log("BlockNoteEditor.create() succeeded without DOM ✓");
  console.log("editor.headless:", editor.headless);
} catch (e: unknown) {
  constructionError = e instanceof Error ? e : new Error(String(e));
  console.log("BlockNoteEditor.create() FAILED:", constructionError.message);
}

// ---------------------------------------------------------------------------
// Test 2: Minimal provider shape — which fields does BlockNote read?
// ---------------------------------------------------------------------------

console.log("\n--- Test 2: Minimal provider shape probe ---\n");

const doc2 = new Y.Doc({ gc: false });
const fragment2 = doc2.getXmlFragment("blocks");

const { awareness, calls: awarenessCalls } = makeInstrumentedAwareness(doc2);

// Capture updates from the ydoc to check if awareness touches it
const ydocUpdates: Uint8Array[] = [];
doc2.on("update", (update: Uint8Array) => {
  ydocUpdates.push(update);
});

const { provider, calls: providerCalls } = makeInstrumentedProvider(awareness);

let editor2: BlockNoteEditor | null = null;
try {
  editor2 = BlockNoteEditor.create(
    withCollaboration({
      collaboration: {
        fragment: fragment2,
        user: { name: "local", color: "#ff0000" },
        provider,
      },
    })
  );
  console.log("BlockNoteEditor.create() with full provider succeeded ✓");
} catch (e: unknown) {
  const err = e instanceof Error ? e : new Error(String(e));
  console.log("BlockNoteEditor.create() FAILED:", err.message);
}

console.log("\nProvider method calls at construction:");
if (providerCalls.length === 0) {
  console.log("  (none)");
} else {
  for (const c of providerCalls) console.log(" ", c);
}

console.log("\nAwareness method calls at construction:");
if (awarenessCalls.length === 0) {
  console.log("  (none)");
} else {
  for (const c of awarenessCalls) console.log(" ", c);
}

// ---------------------------------------------------------------------------
// Test 3: Does awareness state appear in the ydoc update log?
// ---------------------------------------------------------------------------

console.log("\n--- Test 3: Awareness → ydoc update log leakage ---\n");

// Reset counter
ydocUpdates.length = 0;

// Set local awareness state as if presence were live
awareness.setLocalStateField("cursor", { index: 5, length: 0 });
awareness.setLocalStateField("user", { name: "local", color: "#ff0000" });

console.log("ydoc updates triggered by awareness state changes:", ydocUpdates.length);
console.log(
  ydocUpdates.length === 0
    ? "Awareness does NOT write to ydoc update log ✓"
    : "WARNING: Awareness wrote to ydoc update log — must not be persisted"
);

// Confirm awareness uses its own channel
console.log("Awareness local state:", awareness.getLocalState());

// ---------------------------------------------------------------------------
// Test 4: Minimal stub — what is the actual minimum?
// ---------------------------------------------------------------------------

console.log("\n--- Test 4: Absolute minimum (no provider at all) ---\n");

const doc3 = new Y.Doc({ gc: false });
const fragment3 = doc3.getXmlFragment("blocks");

try {
  const editorMin = BlockNoteEditor.create(
    withCollaboration({
      collaboration: {
        fragment: fragment3,
        user: { name: "local", color: "#ff0000" },
        // provider entirely omitted
      },
    })
  );
  console.log("Created with NO provider ✓");
  console.log("editorMin.headless:", editorMin.headless);

  // Try writing a block
  editorMin.insertBlocks(
    [{ type: "paragraph", content: [{ type: "text", text: "hello", styles: {} }] }],
    { id: "initialBlockId" },
    "after"
  );
  console.log("Inserted block successfully ✓");
  console.log("Fragment children:", fragment3.length);
} catch (e: unknown) {
  const err = e instanceof Error ? e : new Error(String(e));
  console.log("FAILED:", err.message);
}

// ---------------------------------------------------------------------------
// Test 5: Does BlockNote call provider.on / provider.off / provider.connect / provider.destroy?
// ---------------------------------------------------------------------------

console.log("\n--- Test 5: Provider lifecycle methods ---\n");

const doc4 = new Y.Doc({ gc: false });
const fragment4 = doc4.getXmlFragment("blocks");
const { awareness: aw4, calls: aw4Calls } = makeInstrumentedAwareness(doc4);

const lifecycleCalls: string[] = [];
const stubbedProvider = {
  awareness: aw4,
  synced: true,
  on: (...args: unknown[]) => {
    lifecycleCalls.push(`on(${args.map(String).join(", ")})`);
  },
  off: (...args: unknown[]) => {
    lifecycleCalls.push(`off(${args.map(String).join(", ")})`);
  },
  connect: (...args: unknown[]) => {
    lifecycleCalls.push(`connect(${args.map(String).join(", ")})`);
  },
  destroy: (...args: unknown[]) => {
    lifecycleCalls.push(`destroy(${args.map(String).join(", ")})`);
  },
};

try {
  const ed4 = BlockNoteEditor.create(
    withCollaboration({
      collaboration: {
        fragment: fragment4,
        user: { name: "local", color: "#ff0000" },
        provider: stubbedProvider,
      },
    })
  );
  console.log("Created with stubbed provider ✓");
  console.log("\nProvider lifecycle method calls:");
  if (lifecycleCalls.length === 0) {
    console.log("  (none)");
  } else {
    for (const c of lifecycleCalls) console.log(" ", c);
  }
  console.log("\nAwareness calls via stubbed provider:");
  if (aw4Calls.length === 0) {
    console.log("  (none)");
  } else {
    for (const c of aw4Calls) console.log(" ", c);
  }
} catch (e: unknown) {
  const err = e instanceof Error ? e : new Error(String(e));
  console.log("FAILED:", err.message);
}

console.log("\n=== Done ===");
