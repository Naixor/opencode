---
name: tui-renderable-review
description: "Review OpenTUI/Solid TUI code for invalid text renderables that can crash TextNodeRenderable handling."
agent:
  - momus
---

# TUI Renderable Review

Use this skill when reviewing `packages/opencode/src/cli/cmd/tui/**/*.tsx` for values that may flow into OpenTUI text rendering and crash at runtime.

## Inspect

- explicit `children={...}` on custom JSX components, especially when forwarding `props.children`
- values interpolated into `<text>...</text>` that are not obviously strings
- conditional branches in text positions that can produce JSX elements, arrays, booleans, objects, or `undefined`
- wrappers such as spinners, labels, badges, and status rows that render through `<text>` internally

## Checklist

- confirm custom components do not use explicit `children={...}` unless the callee explicitly accepts safe text renderables
- confirm `props.children` is not blindly forwarded into components that later render inside `<text>`
- confirm every `<text>{expr}</text>` path resolves to string-like output on every branch
- confirm `&&`, ternaries, `map()`, and helpers used in text positions cannot return JSX objects or arrays of elements
- confirm fallbacks use `""` or plain text, not mixed component/text output

## Examples

Bad:

```tsx
<Spinner children={props.children} />

<text>{busy() && <Spinner />}</text>

<text>{items().map((item) => <Badge>{item.label}</Badge>)}</text>
```

Good:

```tsx
;<Spinner>{label()}</Spinner>

{
  busy() ? <Spinner /> : <text>Idle</text>
}

;<text>
  {items()
    .map((item) => item.label)
    .join(", ")}
</text>
```

## Report

For each finding, include:

- file path
- suspicious expression
- why it may become a non-renderable text node
- smallest safe fix direction

Call out `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` if you see the known regression shape: explicit `children={props.children}` on a custom component that renders text internally.
