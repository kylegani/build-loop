---
name: question-research
description: Answer one research question before building on a guess, from the one kind of source each kind allows - design (reference tools or real shipped products), framework convention (official documentation for the installed version), industry practice (web search with sources) or vendor behaviour (the vendor's own API docs). Use as the research stage of the build loop, or whenever a change does something the repo's own docs don't already settle.
---

# Research

One question, one write-up, one decision. The decision is what builders read; the sources are there for anyone who needs to check it.

## By kind

**design**: follow the screen-design skill's "References" section. Use the design-reference tools the settings list (`design.referenceTools`, loaded with ToolSearch); when there are none, search the web for real, shipped products that do the same job (their public pages, help-centre screenshots, published design systems), and look at the project's own best screens (`design.exemplars`). Several searches, by the job ("invoice list with filters") and by named products that do it well. Look at every screen you cite. Compare at least three real references against what this screen has to do, choose one, and say why in a line. Take structure, never palette: the project's own design docs decide how it looks. Name the existing screen in this project the design should be diffed against, or say why none applies.

**convention**: the library's official documentation, for the version this repo has installed. Read the version from the lockfile or the installed package, not the range in the manifest. Fetch the page with WebFetch from the official site (`officialDocs` and `stack.dependencies` in the settings name them). A docs lookup tool may help you find the page, but cite the official page. Not blog posts, not answers sites, not memory. Say which version the answer holds for. When the docs and the repo's own code disagree, the write-up says both and which one to follow (usually the docs for new code, and a follow-up to bring old code in line).

**practice**: web search. Every claim names its source. Prefer standards bodies (W3C, IETF, OWASP), the maintainers of the tools involved, and engineering writing from teams that run the thing at scale. Two sources that agree beat one that sounds sure.

**vendor**: the vendor's own API documentation, or a fact the repo's docs record as tested. Say plainly when the docs don't settle the question, and what the builder should do then (usually: make the code safe whichever way it goes, and say what the security gate should check).

## The write-up

Write it to the path the loop gives you (`docs/build-loop/research/<slug>/<task>-<n>.md`):

1. **Decision**: what to do, specific enough to build from, in a few short paragraphs. For design: the shape, the chosen reference and why, the screen to diff against, and the states.
2. `## Sources`: each URL, what it says that matters, and the version it applies to. For design: every reference judged, one line each.
3. **Ruled out**: what you considered and why not.

Write in plain words. Never cite a page or screen you didn't open.
