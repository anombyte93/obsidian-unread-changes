/** sha256 of note content, formatted "sha256:<hex>" (Web Crypto — works in Obsidian desktop, iOS, and Node 22 tests). */
export async function hashContent(content: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
	const hex = Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `sha256:${hex}`;
}
