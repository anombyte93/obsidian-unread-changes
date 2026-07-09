/** Shared relative-time formatter for banner + inbox. */
export function timeAgo(ms: number): string {
	const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
	if (s < 60) return "just now";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h} h ago`;
	return `${Math.floor(h / 24)} d ago`;
}
