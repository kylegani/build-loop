---
name: screen-verify
description: Screenshot screens at a desktop and a phone width in every theme and judge them strictly against the project's design docs and the screen-design skill. Use as the UI gate and the design preview of the build loop, or before calling any UI change done.
---

# Screen verify

## Take the pictures

```
node scripts/loop/shoot.mjs --routes "/settings as admin,/ as anonymous"
```

Roles are the keys of `screens.roles` in `.claude/workflows/loop.config.json`. The script shoots each screen at every width and theme the settings name. It uses the server at `screens.baseUrl` when one answers, and otherwise starts `screens.start` and stops it after. It takes the machine's heavy lock, so it waits rather than starting beside an e2e run; don't work around it.

It prints the PNG paths and its problems: a page that answers with an error status, logs a browser error or scrolls sideways. Each problem is a finding.

A screenshot shows the first screenful. When what you need to judge sits lower, say so rather than guessing.

If the script says it can't shoot (no Playwright, no server), report that as the gate's result and judge what you can from the code. Never install anything to make it work.

## Look at every picture

Open each shot you judge once; images are expensive. Judge strictly, against the project's design docs (`design.docs`) and the screen-design skill:

- **Shape**: the screen has the shape of what the person came to do, and matches the closest existing screen in the project.
- **The system**: components, spacing, type and colour come from the project's design system; nothing is hard-coded that the system already names.
- **Emphasis**: one primary action, one page title, the brand colour kept for what matters. Status colours mean what they say.
- **Hierarchy and rhythm**: spacing from the scale, nothing cramped or floating, nothing nested for no reason.
- **States**: full, empty, loading, failed.
- **Contrast**: body text at least 4.5:1, boundaries and icons at least 3:1, in every theme.
- **Phone width**: no sideways scroll, touch targets at least 40px, nothing clipped, and the first screenful shows what the person came for.
- **Words**: consistent naming, errors that say what to do next, the project's writing guide.

If a design critique skill is installed (`design.critiqueSkill`), run it on the screen and fold in what matches the project's design docs.

## Report

For each problem: the screenshot, what is wrong, why it matters, and the fix in one line, most severe first. Name the screens you looked at and found clean.
