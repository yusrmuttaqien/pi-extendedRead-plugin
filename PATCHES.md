# Pi Media Patches

Maintenance checklist for the pi patches applied by this plugin.

## Targets

| ID | File | Change | Anchor (first 40 chars) | Sentinel |
|---|---|---|---|---|
| `convertMessages` | `dist/bundle/chunks/openai-completions-*.js` | Add audio/video block detection + serialization | `type:"image"` | `// pi-media-patch:v1:convertMessages` |
| `convertMessagesBlocks` | `dist/bundle/chunks/openai-completions-*.js` | Map audio/video blocks to input_audio/input_video | `isImageContentBlock(block)` | `// pi-media-patch:v1:convertMessagesBlocks` |
| `compaction` | `dist/core/compaction/compaction.js` | Add ESTIMATED_AUDIO_CHARS, ESTIMATED_VIDEO_CHARS | `ESTIMATED_IMAGE_CHARS` | `// pi-media-patch:v1:compaction` |

## After a pi update

1. Run `/extended-read-patch` in pi.
2. If any target reports `not-found`, the pi update changed the code structure.
3. Open the target file in pi's install, find the new anchor string.
4. Update `src/patch/targets.ts`: new `search` + `replace` for that target.
5. Bump the version in `targets.ts` (`const VERSION = "v1"` → `"v2"`).
6. Re-run `/extended-read-patch` to verify.

## Verifying a patch is applied

```bash
# Check sentinel in the bundle:
grep "pi-media-patch" $(node -e "console.log(require.resolve('@earendil-works/pi-coding-agent/package.json').split('package.json')[0])")/dist/bundle/chunks/openai-completions-*.js

# Check compaction:
grep "ESTIMATED_AUDIO_CHARS" $(node -e "console.log(require.resolve('@earendil-works/pi-coding-agent/package.json').split('package.json')[0])")/dist/core/compaction/compaction.js
```
