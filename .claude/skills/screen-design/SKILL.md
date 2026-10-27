---
name: screen-design
description: Design or redesign a screen, page, panel or component before building it, so it follows the project's own design system instead of a model's defaults. Use before laying out any new surface, when asked to redesign or restyle one, when something is called ugly, generic, cluttered or AI-looking, or when choosing layout, colour or a component. Covers finding references, diffing against the project's best existing screen, the surface ladder, every state, and looking at the real render.
---

# Screen design

A surface is designed by whoever builds it, in the same task, before it is built, and checked by looking at the real screen. Drafts made from defaults look like every other generated screen. Most of the drift comes from choosing the wrong component or shape, more than from styling, so most of this skill is about choosing.

Read before the first draft: the project's design docs (`design.docs` in `.claude/workflows/loop.config.json`), its product or brand doc if it has one, and its UI kit's documentation for the installed version.

## The order

1. **Say what the person came to this screen to do**, in one sentence, and what the screen is shaped like: a day, a ledger, a list with a detail, a form, a wizard, a dashboard. The shape picks the lead element.
2. **Find the closest existing screen** in this project that already does it well (`design.exemplars`, or search the codebase). Diff against it and name it, or say why none applies. Reusing the project's own answer beats inventing one.
3. **Climb the surface ladder no higher than the task needs**: inline edit, popover, confirmation dialog, dialog, side sheet, full page. A small edit doesn't get its own page.
4. **Find references** for anything the project's own screens don't settle (see References). Take structure, never palette.
5. **Write the composition down** in two or three sentences. In the build loop it goes in the task's research decision or your result.
6. **Build it from the system.** The project's existing components, layout primitives, spacing scale, type scale and colour tokens. Never hard-code a colour, size or font the system already names. Follow the UI kit's own conventions for the installed version.
7. **Design every state**: full, empty, loading, failed, and for forms, invalid and saving. An error is never dressed up as an empty state.
8. **Render the real screen and look**, at a desktop and a phone width, in every theme (the screen-verify skill). In the build loop a builder can't render; the preview and the UI gate do.
9. **Critique and polish.** If a design critique skill is installed (`design.critiqueSkill`), run it and act on findings that match the project's design docs; ignore ones that push past the task.
10. **Write down any convention you set**, with its reason, in the project's design docs.

## Defaults to avoid

These are the marks of a generated screen. Avoid them unless the project's design docs ask for them:

- A wall of equal metric cards, or a grid of identical icon cards.
- A card inside a card, heavy borders everywhere, or coloured side stripes on cards.
- Brand colour spread across the page instead of kept for the one primary action and the key figure.
- Red, amber and green used for status everywhere, so red stops meaning danger.
- Uppercase tracked labels above every section, gradients and glass as decoration.
- A summary of nothing ("All clear!") where the space should show the next thing to do.
- Inputs stretched to the full width of a wide card.

## References

When `design.referenceTools` lists tools (for example a screen and flow search MCP), load them with ToolSearch first.

- Search by a concrete job or a named product that does it well ("Stripe invoice detail panel", "Linear settings sheet"), not by style adjectives, and not by describing what you want to avoid.
- Search flows as well as single screens when the job spans steps.
- Keep result counts small (8 to 12): every result is an image to read.

When there are no reference tools, search the web for the same thing: product pages, help-centre articles with screenshots, and published design systems of products that do the job. A screenshot in a help article shows the real product, which beats a marketing mock-up.

Either way: look at every reference you cite, compare at least three against what the screen has to do, choose one and say why, and take its structure, never its palette.

## Done means

- The closest existing screen named or ruled out, and a reference where the project's screens didn't settle it.
- Every state designed.
- Rendered at both widths in every theme and looked at (by you, or by the loop's preview or UI gate).
- Any convention it set is written down.
