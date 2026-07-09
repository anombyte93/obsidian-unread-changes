// Minimal stub of the 'obsidian' module for unit tests.
// Core logic modules are pure and must not need this; it exists so files that
// transitively import 'obsidian' types still resolve under vitest.

export class Plugin {}
export class ItemView {}
export class Modal {}
export class Notice {
	constructor(_msg: string) {}
}
export class PluginSettingTab {}
export class Setting {}
export class TFile {}
export class TFolder {}
export class MarkdownView {}
export const Platform = { isMobile: false, isDesktopApp: true, isIosApp: false };
export function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "");
}
export function debounce<T extends (...args: never[]) => void>(fn: T): T {
	return fn;
}
export function requireApiVersion(_v: string): boolean {
	return true;
}
