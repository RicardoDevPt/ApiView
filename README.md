# openapi_view

VS Code extension that visualizes an OpenAPI (3.x / Swagger 2) YAML or JSON file: every endpoint,
grouped by tag, with its parameters, request body and response schemas (`$ref`s resolved).

## Use
Open a spec file and run **OpenAPI: Preview** (command palette, editor title button, or right-click).
The panel updates as you edit. Filter box matches method, path, summary, operationId and tag.

The **OpenAPI** activity-bar view (`{..}` icon) lists the active spec's endpoints by tag: click one
to open it in the preview, or use the inline button to jump to its definition in the source.

Each endpoint has a **Try it** section: parameters and the JSON body as a form prefilled with
defaults/examples (dropdowns for enums and booleans, limits from the schema are validated), a base
address and **Send**. The base address is remembered per spec file (initially `servers[0].url`).
Requests are sent by the extension host, so under Remote-SSH they leave from the remote machine
(install the extension in the SSH host when VS Code offers). Form edits reset when the spec is edited.

## Build
```bash
npm install
npm test            # compile + self-check
npm run package     # produces openapi-view-<version>.vsix
code --install-extension openapi-view-0.1.0.vsix
```
Press F5 in this folder to run it in an Extension Development Host.

Limitations: only local `#/...` refs (no external files).
