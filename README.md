# tometo

A Claude Code plugin marketplace hosting **tometo**: garden a codebase that agents write. Watch for weeds,
queue them with evidence, and turn each recurring weed into a rule so it cannot grow back.

```text
/plugin marketplace add tometo-tub/tometo
/plugin install tometo@tometo
```

The plugin lives in [`plugins/tometo/`](plugins/tometo/); its [README](plugins/tometo/README.md)
covers the skills, the garden site and usage. [`GLOSSARY.md`](GLOSSARY.md) defines the terms.

## Development

Node.js 22.18 or later.

```bash
npm ci
npm run check
claude --plugin-dir ./plugins/tometo
```

`npm run check` type-checks, lints, checks formatting and runs every test, including `tools/hygiene.test.ts`,
which keeps the plugin free of references to other tools and the maintainer's identity public.

## License

MIT, see [LICENSE](LICENSE).
