/**
 * Panel layout + speech balloons.
 *
 * Three things the storyboard writer now decides per script line, appended to its
 * picture prompt as a strict machine-readable tail:
 *
 *   ... prompt body ... || FRAMES: 2 || BEATS: 1) ... ; 2) ... || DIALOGUE: 1) Ravi: "Run!" ; 2) NONE || NARRATION: 1) That night... ; 2) NONE
 *
 * FRAMES is how many comic frames that ONE timestamp is drawn as. It follows
 * the timestamp's own length and its own number of story beats, so a short
 * timestamp stays a single frame and no frame is ever padded in to fill a grid.
 *
 * DIALOGUE is the spoken line translated into short, natural ENGLISH, which the
 * image model letters into a proper speech balloon. Lines with no speech get
 * NONE and stay wordless.
 *
 * NARRATION preserves the remaining story text as short, natural ENGLISH in a
 * rectangular webtoon story box. It is separate from speech and never gains a
 * balloon tail.
 *
 * The tail is parsed off before the prompt body is sanitised (the sanitiser
 * deliberately removes every mention of text and balloons from the body, since
 * only this module is allowed to ask for lettering).
 */

export type Bubble = {
  /** Who speaks, when the writer named them. */
  speaker: string;
  /** Short English line to letter, already translated. */
  text: string;
};

export type PanelPlan = {
  /** The picture prompt with the tail removed. */
  body: string;
  /** 1 to 4. */
  frames: number;
  /** One short sub-action per frame (only for multi-frame timestamps). */
  beats: string[];
  /** One entry per frame; an empty text means that frame is silent. */
  bubbles: Bubble[];
  /** One translated story-box caption per frame; empty means no narration. */
  narration: string[];
};

export const MAX_FRAMES = 4;

/**
 * Frame budget from the timestamp's own duration. This is a CEILING, never a
 * target: the writer may always ask for fewer, and a timestamp with one beat
 * stays one frame however long it is.
 */
export function frameCeiling(durationSeconds: number): number {
  const d = Number.isFinite(durationSeconds) ? durationSeconds : 0;
  if (d < 5) return 1;
  if (d < 9) return 2;
  if (d < 15) return 3;
  return MAX_FRAMES;
}

const SPLIT = /\|\|/;

function splitList(raw: string): string[] {
  // "1) first ; 2) second" -> ["first", "second"]
  const parts = raw
    .split(/\s*;\s*|\s*\|\s*/)
    .map((p) => p.replace(/^\s*(?:frame\s*)?\d+\s*[).:-]\s*/i, "").trim())
    .filter((p) => p.length > 0);
  return parts;
}

function parseBubble(raw: string): Bubble {
  const value = raw.trim();
  if (!value || /^none$|^silent$|^-$/i.test(value)) return { speaker: "", text: "" };
  // Ravi: "Run now!"  |  Ravi says: Run now!  |  "Run now!"
  const m = /^([^:"'“”]{1,40}?)\s*(?:says?)?\s*:\s*(.+)$/.exec(value);
  const speaker = m ? m[1]!.trim() : "";
  const spoken = (m ? m[2]! : value).trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
  if (!spoken || /^none$/i.test(spoken)) return { speaker: "", text: "" };
  // Balloons hold a line, not a paragraph.
  const words = spoken.split(/\s+/);
  const clipped = words.length > 14 ? `${words.slice(0, 14).join(" ")}` : spoken;
  return { speaker, text: clipped.replace(/\s+/g, " ") };
}

function parseNarration(raw: string): string {
  const value = raw.trim().replace(/^['“”]+|['“”]+$/g, "").trim();
  if (!value || /^none$|^silent$|^-$/i.test(value)) return "";
  const words = value.split(/\s+/);
  return (words.length > 22 ? words.slice(0, 22).join(" ") : value).replace(/\s+/g, " ");
}

/**
 * Reads the writer's tail off a prompt, wherever it sits. The writer sometimes
 * drops the tail in the MIDDLE of the prompt (before the location lock), so each
 * tail value is cut at its own sentence end and whatever followed is handed back
 * to the picture body instead of being lettered into a balloon.
 *
 * A prompt without a tail (older cached prompts, repairs, manual edits) is simply
 * a silent single frame — exactly how this app behaved before.
 */
export function parsePanelPlan(written: string, durationSeconds?: number): PanelPlan {
  let frames = 1;
  let beats: string[] = [];
  let bubbles: Bubble[] = [];
  let narration: string[] = [];
  const leftovers: string[] = [];

  // "|| KEY: value" up to the next "||" or the end of the line.
  const body = written
    .replace(/\|\|\s*(FRAMES|BEATS|DIALOGUE|NARRATION)\s*:\s*([^|]*)/gi, (_all, rawKey: string, rawValue: string) => {
      const key = rawKey.toUpperCase();
      let value = rawValue.trim();
      // A value never runs into the next instruction sentence: cut at the first
      // ". Capitalised…" that is not part of a "1) …" list item.
      const cut = /[.?!]\s+(?=[A-Z][A-Za-z]{2,})/.exec(value);
      if (cut && cut.index !== undefined) {
        leftovers.push(value.slice(cut.index + 1).trim());
        value = value.slice(0, cut.index).trim();
      }
      if (key === "FRAMES") {
        const n = Number.parseInt(value.replace(/\D+/g, ""), 10);
        if (Number.isFinite(n)) frames = n;
      } else if (key === "BEATS") {
        beats = splitList(value);
      } else if (key === "DIALOGUE") {
        bubbles = splitList(value).map(parseBubble);
      } else if (key === "NARRATION") {
        narration = splitList(value).map(parseNarration);
      }
      return " ";
    })
    .concat(leftovers.length ? ` ${leftovers.join(" ")}` : "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Never pad: the frame count is the smallest of what the writer asked for,
  // what the duration allows, and how many beats it actually described.
  const ceiling = durationSeconds === undefined ? MAX_FRAMES : frameCeiling(durationSeconds);
  frames = Math.max(1, Math.min(frames, ceiling, MAX_FRAMES));
  if (beats.length > 0) frames = Math.min(frames, beats.length);
  if (frames === 1) beats = [];
  else beats = beats.slice(0, frames);
  bubbles = bubbles.slice(0, frames);
  narration = narration.slice(0, frames);

  return { body, frames, beats, bubbles, narration };
}


const ORDINAL = ["first", "second", "third", "fourth"];

/** Small stable hash so the same panel always gets the same layout. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * Dynamic manhwa page layouts — never a plain equal grid. Each option is a real
 * published-webtoon composition: tilted frames, uneven weights, one dominant
 * frame, frames that bleed off the page edge and art that breaks a border.
 */
const LAYOUTS: Record<number, string[]> = {
  2: [
    "a dramatic manhwa page layout of exactly 2 frames: a narrow full-width letterbox frame across the top and one huge tall frame filling the rest below it, both slightly tilted with a jagged diagonal white gutter between them, the lower frame's action breaking over its border",
    "a dynamic manhwa page layout of exactly 2 frames split by one steep diagonal white gutter running corner to corner, the upper-left frame smaller and the lower-right frame dominant and full-bleed, borders angled and irregular",
    "a bold manhwa page layout of exactly 2 frames: one enormous full-bleed frame filling the page, with a smaller tilted inset frame overlapping its lower-left corner inside a thick white border",
  ],
  3: [
    "a dramatic manhwa page layout of exactly 3 frames: a wide thin letterbox frame across the top, a tall tilted frame below it on the left, and a bigger dominant frame on the right bleeding off the page edge, all separated by irregular angled white gutters",
    "a dynamic manhwa page layout of exactly 3 frames stacked as uneven horizontal bands of different heights, each band slanted at a slightly different angle with jagged white gutters, the middle band the widest and most dominant, action breaking across the gutters",
    "a bold manhwa page layout of exactly 3 frames: two small stacked frames down the left side and one towering full-height frame on the right taking two thirds of the page, tilted borders, thick uneven white gutters, one character breaking out of a frame edge",
  ],
  4: [
    "a dramatic manhwa page layout of exactly 4 frames of clearly different sizes: a thin wide establishing frame on top, two small tilted frames side by side in the middle, and one huge dominant climax frame across the bottom bleeding off the edges, all with angled irregular white gutters",
    "a dynamic manhwa page layout of exactly 4 frames arranged around one big central diagonal frame: three narrow slanted frames tucked along the top and left, the central frame dominant and full-bleed with art breaking over its borders, jagged white gutters",
    "a bold asymmetric manhwa page layout of exactly 4 frames of unequal size and angle, staggered like shattered glass with steep diagonal white gutters, one frame at least twice the size of the others, effects and debris crossing between frames",
  ],
};

function layoutOf(frames: number, key: string): string {
  const options = LAYOUTS[Math.min(4, Math.max(2, frames))] ?? LAYOUTS[2]!;
  return options[hash(key) % options.length]!;
}

function balloonFor(b: Bubble, where: string): string {
  const who = b.speaker ? `${b.speaker}'s` : "the speaking character's";
  return (
    `${where} draw one clean white manhwa speech balloon with a smooth bold black outline and a pointed tail aimed at ` +
    `${who} mouth, placed over empty background so it covers no face, containing ONLY this exact English text, ` +
    `spelled exactly, in bold upright comic lettering fully inside the balloon: "${b.text}"`
  );
}

function storyBoxFor(text: string, where: string): string {
  return (
    `${where} place one clean solid black rectangular Korean webtoon narration box with a crisp white border, ` +
    `generous inner spacing and no pointer tail, positioned over quiet negative space without covering a face or action, ` +
    `containing ONLY this exact English story text, spelled exactly, in clear upright bold white comic lettering: "${text}"`
  );
}

/**
 * The lettering and layout instruction, appended AFTER the sanitised picture
 * prompt so it survives untouched. Returns "" for a silent single frame, which
 * keeps the old wordless behaviour byte for byte.
 */
export function panelDirective(plan: PanelPlan): string {
  const spoken = plan.bubbles.filter((b) => b.text.length > 0);
  const narrated = plan.narration.filter((text) => text.length > 0);
  if (plan.frames <= 1 && spoken.length === 0 && narrated.length === 0) return "";

  const out: string[] = [];

  if (plan.frames > 1) {
    out.push(
      `render this as ONE manhwa comic page in ${layoutOf(plan.frames, plan.body)}, every frame in the same art ` +
        `style with the same characters and the same location, showing consecutive moments of this one scene, ` +
        `cinematic varied camera distance per frame, no equal boxy grid and no repeated identical frame shape`,
    );
    plan.beats.forEach((beat, i) => {
      out.push(`the ${ORDINAL[i] ?? `frame ${i + 1}`} frame shows ${beat.replace(/\.$/, "")}`);
    });
  }

  plan.bubbles.forEach((b, i) => {
    if (!b.text) return;
    const where =
      plan.frames > 1 ? `in the ${ORDINAL[i] ?? `frame ${i + 1}`} frame,` : "in the upper area of the frame,";
    out.push(balloonFor(b, where));
  });

  plan.narration.forEach((text, i) => {
    if (!text) return;
    const where =
      plan.frames > 1
        ? `in the ${ORDINAL[i] ?? `frame ${i + 1}`} frame, near the top or bottom edge,`
        : "near the top or bottom edge of the illustration,";
    out.push(storyBoxFor(text, where));
  });

  if (spoken.length > 0 || narrated.length > 0) {
    out.push(
      "the specified speech-balloon and narration-box text is the only readable writing in the image apart from a script-matched action SFX; no subtitles, signs or watermark",
    );
  }

  return out.join(". ");
}

