# P0 ZIP Spike

## Environment

- Node: `v25.2.1`
- OS: Windows `10.0.19044`, `win32`, `x64`
- Runtime: `node --expose-gc --experimental-strip-types`
- Operation: `PackageArchive.open(sample)` followed by `archive.serialize()`
- Runs: 3 per sample
- Memory: `globalThis.gc()` before each run; RSS is recorded before and after the operation. `rssDelta` is the measured increase, not a sampled peak.

The benchmark generated each sample in memory. Each sample is a deterministic stored ZIP containing `[Content_Types].xml`, `_rels/.rels`, `word/document.xml`, and a deterministic `word/media/deterministic.bin` payload. The payload byte at offset `i` is `(i * 31 + (i >>> 8) * 17 + 0x5a) & 0xff`. No sample was written to disk.

## Sample Sizes

| Payload | Compressed entry bytes | Uncompressed entry bytes | ZIP bytes | Runs |
| ---: | ---: | ---: | ---: | ---: |
| 10 MiB | 10,486,312 | 10,486,312 | 10,486,788 | 3 |
| 50 MiB | 52,429,352 | 52,429,352 | 52,429,828 | 3 |

These are stored entries, so compressed and uncompressed entry totals are equal. ZIP bytes include local headers, central-directory records, and EOCD overhead.

## Results

### 10 MiB

| Round | Elapsed ms | Baseline RSS bytes | After RSS bytes | RSS delta bytes | RSS delta MiB |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 565.664 | 96,522,240 | 119,975,936 | 23,453,696 | 22.37 |
| 2 | 559.184 | 109,166,592 | 141,045,760 | 31,879,168 | 30.40 |
| 3 | 349.479 | 109,633,536 | 141,107,200 | 31,473,664 | 30.02 |

### 50 MiB

| Round | Elapsed ms | Baseline RSS bytes | After RSS bytes | RSS delta bytes | RSS delta MiB |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1,734.763 | 221,437,952 | 305,324,032 | 83,886,080 | 80.00 |
| 2 | 1,686.415 | 231,915,520 | 284,348,416 | 52,432,896 | 50.00 |
| 3 | 1,750.533 | 284,356,608 | 389,226,496 | 104,869,888 | 100.01 |

The RSS delta varies between rounds because the runtime allocator retains native/external memory between collections. The timings include archive validation, bounded stored-entry reads, CRC checks, and the no-op serialization copy.

## P0/P1 Decision Notes

- `fflate` `0.8.2` remains the bounded streaming inflate/deflate implementation. Its high-level ZIP API does not expose enough metadata for raw-copy rewriting, so `PackageArchive` owns the small ZIP metadata rewrite layer already required for validation.
- P0 no-op serialization returns the original package bytes byte-for-byte.
- The package-internal `rewritePackageEntry(archive, path, content)` resolves the P1 edited raw-copy writer gate without another dependency:
  - the target entry keeps its original stored/deflate method and deflate-level flags;
  - every untouched local header, extra field, filename, and compressed payload is copied byte-for-byte;
  - the target local/central CRC and sizes are replaced;
  - central-directory local offsets are updated because a changed compressed size can move later records;
  - EOCD comments and bytes outside entry records are preserved;
  - the generated archive is reopened under the original resource limits before it is returned.
- The writer intentionally replaces existing entries only and is not exported from the package entry point. Adding, deleting, renaming, ZIP64, encryption, data descriptors, and unsupported compression methods remain out of scope.
- P1 DOCX editing can proceed on this writer, but semantic operations must remain the only public document mutation surface; Desktop and Agent callers must not use raw package entry replacement directly.
