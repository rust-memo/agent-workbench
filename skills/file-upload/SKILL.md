---
name: file-upload
description: Assess authorized file-upload pipelines for validation, storage, retrieval, metadata, parser, path, access-control, and active-content weaknesses. Use when recon finds multipart forms, avatars, imports, attachments, document conversion, archives, or media processing.
---

# File Upload

Use inert marker files first. Map the pipeline from client validation to ingestion, scanning, transformation, storage, serving, deletion, and downstream parsing.

## Workflow

1. Record accepted extensions, MIME types, magic bytes, size limits, filenames, metadata, storage URLs, access controls, and transformations.
2. Establish a benign baseline with a unique marker and verify who can read, replace, and delete it.
3. Test mismatches one dimension at a time: extension versus MIME/magic bytes, duplicate extensions, case, Unicode normalization, filename/path handling, and metadata.
4. Check direct-object authorization, predictable URLs, cache headers, content disposition, content sniffing, SVG/HTML active content, and cross-origin delivery.
5. For archives or document converters, use tiny bounded samples. Test traversal or parser behavior only with inert paths and strict size/depth limits.
6. Verify deletion and replacement semantics and whether derived thumbnails/previews remain accessible.

## Guardrails and output

- Never upload executable server code, malware, decompression bombs, or files intended to escape the authorized storage area.
- Do not use production personal data; strip metadata and use synthetic contents.
- Require approval before any sample that triggers server-side parsing or conversion.

Return a pipeline diagram, validation matrix, accessible URLs, observed transformations, proof artifacts, and prioritized manual checks. Distinguish “accepted” from “executed” or “served unsafely.”
