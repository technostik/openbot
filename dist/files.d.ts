export interface TreeEntry {
    path: string;
    type: "dir" | "file";
    size?: number;
    modified?: string;
}
/** Breadth-limited directory listing, relative paths, dirs first. */
export declare function listTree(root: string, opts?: {
    depth?: number;
    max?: number;
}): {
    entries: TreeEntry[];
    truncated: boolean;
    exists: boolean;
};
/** Compact text rendering of a tree. */
export declare function renderTree(root: string, opts?: {
    depth?: number;
    max?: number;
}): string;
/** Reads a text file inside `root` only (no path escapes), clipped to `maxBytes`. */
export declare function readInside(root: string, rel: string, maxBytes?: number): {
    ok: true;
    content: string;
    truncated: boolean;
} | {
    ok: false;
    error: string;
};
