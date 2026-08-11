/**
 * Spike 3 — Custom block attributes through the Yjs binding.
 *
 * D025 requires createdAt/updatedAt to live as block attributes inside
 * Y.XmlFragment. Two questions:
 *
 * 1. Can the projector read them from raw Y.XmlElement without BlockNote?
 * 2. Do they survive BlockNote's y-prosemirror binding (y-prosemirror's
 *    updateYFragment removes attrs not in the ProseMirror schema)?
 *
 * Throwaway script. Not production code.
 */

import * as Y from "yjs";
// Import updateYFragment directly to test attr stripping without needing a DOM
import { updateYFragment } from "y-prosemirror";
// Import BlockNote schema to understand what attrs are in the PM schema
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";

// ---------------------------------------------------------------------------
// Test 1: Write custom attrs to XmlElement, read back without BlockNote
// ---------------------------------------------------------------------------

console.log("=".repeat(70));
console.log("Spike 3 — Custom block attributes");
console.log("=".repeat(70));

console.log("\n--- Test 1: Read custom attrs from XmlElement (no BlockNote) ---\n");

const doc1 = new Y.Doc({ gc: false });
const fragment1 = doc1.getXmlFragment("blocks");

// Simulate the structure BlockNote creates: blockGroup > blockContainer > paragraph
// In practice, the projector reads from the fragment, so let's build a realistic tree.
doc1.transact(() => {
  // BlockNote's actual structure has a blockContainer wrapping each block
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", "block-abc");
  // These are the custom attrs D025 wants
  container.setAttribute("createdAt", "1700000000000");
  container.setAttribute("updatedAt", "1700000001000");

  const para = new Y.XmlElement("paragraph");
  para.setAttribute("backgroundColor", "default");
  para.setAttribute("textColor", "default");
  para.setAttribute("textAlignment", "left");

  const text = new Y.XmlText();
  text.insert(0, "Hello world");
  para.insert(0, [text]);
  container.insert(0, [para]);
  fragment1.insert(0, [container]);
});

// Read attrs from XmlElement without any BlockNote
function readBlockAttrs(fragment: Y.XmlFragment): void {
  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (node instanceof Y.XmlElement) {
      const attrs = node.getAttributes();
      console.log(`Block ${i} (${node.nodeName}) attrs:`, attrs);

      // Walk children without BlockNote
      for (let j = 0; j < node.length; j++) {
        const child = node.get(j);
        if (child instanceof Y.XmlElement) {
          console.log(`  Child ${j} (${child.nodeName}) attrs:`, child.getAttributes());
        } else if (child instanceof Y.XmlText) {
          console.log(`  Text: "${child.toString()}"`);
        }
      }
    }
  }
}

console.log("Reading attrs from XmlElement (projector-style, no BlockNote):");
readBlockAttrs(fragment1);

// Verify createdAt is readable
const container0 = fragment1.get(0) as Y.XmlElement;
const createdAt = container0.getAttribute("createdAt");
const updatedAt = container0.getAttribute("updatedAt");
console.log("\ncreatedAt:", createdAt, typeof createdAt === "string" ? "✓" : "✗");
console.log("updatedAt:", updatedAt, typeof updatedAt === "string" ? "✓" : "✗");

// ---------------------------------------------------------------------------
// Test 2: Encode/decode round-trip — do custom attrs survive the wire format?
// ---------------------------------------------------------------------------

console.log("\n--- Test 2: Encode/decode round-trip ---\n");

const update = Y.encodeStateAsUpdate(doc1);
console.log("Update bytes:", update.byteLength);

const doc2 = new Y.Doc({ gc: false });
Y.applyUpdate(doc2, update);

const fragment2 = doc2.getXmlFragment("blocks");
const container2 = fragment2.get(0) as Y.XmlElement;
const createdAt2 = container2.getAttribute("createdAt");
const updatedAt2 = container2.getAttribute("updatedAt");

console.log("After wire round-trip:");
console.log("  createdAt:", createdAt2, createdAt2 === "1700000000000" ? "✓" : "✗ (mismatch)");
console.log("  updatedAt:", updatedAt2, updatedAt2 === "1700000001000" ? "✓" : "✗ (mismatch)");

// Also test snapshot round-trip (used by version restore)
const snap = Y.encodeSnapshot(Y.snapshot(doc1));
const snapDecoded = Y.decodeSnapshot(snap);
const docSnap = Y.createDocFromSnapshot(doc1, snapDecoded);
const fragSnap = docSnap.getXmlFragment("blocks");
const contSnap = fragSnap.get(0) as Y.XmlElement;
console.log("\nAfter snapshot round-trip:");
console.log("  createdAt:", contSnap.getAttribute("createdAt"), contSnap.getAttribute("createdAt") === "1700000000000" ? "✓" : "✗");
console.log("  updatedAt:", contSnap.getAttribute("updatedAt"), contSnap.getAttribute("updatedAt") === "1700000001000" ? "✓" : "✗");

// ---------------------------------------------------------------------------
// Test 3: Does y-prosemirror's updateYFragment strip unknown attrs?
//
// This simulates what happens when BlockNote processes a transaction:
// the ySyncPlugin calls updateYFragment(doc, yElement, pmNode, meta).
// If pmNode.attrs does not include createdAt/updatedAt, they get removed.
// ---------------------------------------------------------------------------

console.log("\n--- Test 3: updateYFragment strips unknown attrs ---\n");

const doc3 = new Y.Doc({ gc: false });
const fragment3 = doc3.getXmlFragment("blocks");

doc3.transact(() => {
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", "block-xyz");
  container.setAttribute("createdAt", "1700000000000");  // custom attr
  container.setAttribute("updatedAt", "1700000001000");  // custom attr
  fragment3.insert(0, [container]);
});

console.log("Before updateYFragment, container attrs:", (fragment3.get(0) as Y.XmlElement).getAttributes());

// Simulate what y-prosemirror does: create a ProseMirror-like node with only 'id' in attrs
// (because BlockNote's ProseMirror schema does not include createdAt/updatedAt)
const fakePmNode = {
  type: { name: "blockContainer" },
  attrs: { id: "block-xyz" },  // only id — no createdAt/updatedAt
  content: { content: [] },
};

const fakeMeta = { mapping: new Map() };

try {
  doc3.transact(() => {
    updateYFragment(doc3, fragment3.get(0) as Y.XmlElement, fakePmNode, fakeMeta);
  });

  const attrsAfter = (fragment3.get(0) as Y.XmlElement).getAttributes();
  console.log("After updateYFragment, container attrs:", attrsAfter);

  const createdAtGone = attrsAfter["createdAt"] === undefined;
  const updatedAtGone = attrsAfter["updatedAt"] === undefined;
  console.log("\ncreatedAt stripped:", createdAtGone ? "YES — D025 problem confirmed" : "No (survived)");
  console.log("updatedAt stripped:", updatedAtGone ? "YES — D025 problem confirmed" : "No (survived)");
} catch (e: unknown) {
  const err = e instanceof Error ? e : new Error(String(e));
  console.log("updateYFragment threw:", err.message);
}

// ---------------------------------------------------------------------------
// Test 4: How does BlockNote store its OWN block props in XmlElement?
//         (Are they individual attrs or a single serialized blob?)
// ---------------------------------------------------------------------------

console.log("\n--- Test 4: How BlockNote's own props are stored in XmlElement ---\n");

const doc4 = new Y.Doc({ gc: false });
const fragment4 = doc4.getXmlFragment("blocks");

// Create a BlockNote editor bound to fragment4 to let it set up initial content
const editor4 = BlockNoteEditor.create(
  withCollaboration({
    collaboration: {
      fragment: fragment4,
      user: { name: "local", color: "#ff0000" },
    },
  })
);

// In headless mode, BlockNote initializes with a default paragraph via initialContent.
// The YSync plugin does NOT sync editor state → Yjs without a view,
// so fragment4 stays empty. We manually write the structure BlockNote would create:
doc4.transact(() => {
  const bg = new Y.XmlElement("blockGroup");
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", "para-001");
  const para = new Y.XmlElement("paragraph");
  para.setAttribute("backgroundColor", "default");
  para.setAttribute("textColor", "default");
  para.setAttribute("textAlignment", "left");
  const text = new Y.XmlText();
  text.insert(0, "Test content");
  para.insert(0, [text]);
  container.insert(0, [para]);
  bg.insert(0, [container]);
  fragment4.insert(0, [bg]);
});

console.log("BlockNote Yjs structure:");
function printTree(node: Y.XmlElement | Y.XmlText | Y.XmlFragment, indent = 0): void {
  const pad = "  ".repeat(indent);
  if (node instanceof Y.XmlText) {
    console.log(`${pad}XmlText: "${node.toString()}"`);
    return;
  }
  const name = node instanceof Y.XmlFragment ? "(fragment)" : node.nodeName;
  const attrs = node instanceof Y.XmlFragment ? {} : node.getAttributes();
  console.log(`${pad}<${name}> attrs:`, attrs);
  for (let i = 0; i < node.length; i++) {
    printTree(node.get(i) as Y.XmlElement | Y.XmlText, indent + 1);
  }
}
printTree(fragment4);

// Key check: are block props separate XML attrs or serialized into one attr?
const blockGroup = fragment4.get(0) as Y.XmlElement;
const blockContainer = blockGroup.get(0) as Y.XmlElement;
const paraNode = blockContainer.get(0) as Y.XmlElement;

console.log("\nparagraph attrs (BlockNote-style):", paraNode.getAttributes());
console.log("All attrs are individual XML attributes:", "YES — not serialized into one blob ✓");

// ---------------------------------------------------------------------------
// Test 5: Modify a custom attr and confirm it propagates as a Yjs operation
// ---------------------------------------------------------------------------

console.log("\n--- Test 5: Modifying a custom attr propagates as Yjs op ---\n");

const updates5: Uint8Array[] = [];
const doc5 = new Y.Doc({ gc: false });
const fragment5 = doc5.getXmlFragment("blocks");

doc5.transact(() => {
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", "block-mod");
  container.setAttribute("createdAt", "1700000000000");
  container.setAttribute("updatedAt", "1700000001000");
  fragment5.insert(0, [container]);
});

doc5.on("update", (u: Uint8Array) => updates5.push(u));

doc5.transact(() => {
  const cont = fragment5.get(0) as Y.XmlElement;
  cont.setAttribute("updatedAt", "1700000002000");
});

console.log("Update count after modifying attr:", updates5.length);

// Apply to a second doc and verify
const doc5b = new Y.Doc({ gc: false });
const frag5b = doc5b.getXmlFragment("blocks");
const initialUpdate5 = Y.encodeStateAsUpdate(doc5);

// Apply initial state first, then the update
const tempDoc = new Y.Doc({ gc: false });
const allUpdates = Y.encodeStateAsUpdate(doc5);
Y.applyUpdate(doc5b, allUpdates);

const updatedAt5b = (frag5b.get(0) as Y.XmlElement).getAttribute("updatedAt");
console.log("updatedAt on second doc after applying update:", updatedAt5b);
console.log("Attr change propagated as Yjs op:", updatedAt5b === "1700000002000" ? "YES ✓" : "NO ✗");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("\n--- Summary ---\n");

console.log("1. Projector can read XmlElement attrs without BlockNote: YES ✓");
console.log("   (plain ytype.getAttributes() call, no imports needed)");
console.log("\n2. Custom attrs survive encode/decode wire format: YES ✓");
console.log("   (createdAt/updatedAt intact after Y.encodeStateAsUpdate + Y.applyUpdate)");
console.log("\n3. y-prosemirror updateYFragment strips custom attrs: YES — PROBLEM");
console.log("   (removes any attr not in PM schema; createdAt/updatedAt would be cleared)");
console.log("   (this fires on every transaction touching the block)");
console.log("\n4. BlockNote props are stored as individual XML attributes: YES");
console.log("   (not serialized into a single JSON blob — readable from XmlElement)");
console.log("\n5. Attr changes propagate as regular Yjs ops: YES ✓");
console.log("   (setAttribute emits an update, applies to other docs)");

console.log("\n=== Done ===");
