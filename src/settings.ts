import { App, PluginSettingTab, Setting } from "obsidian";
import type UnreadChangesPlugin from "./main";

export type MarkReadMode = "dwell" | "instant" | "manual";

export interface UnreadChangesSettings {
	/** vault folder holding per-device read-state JSON files */
	stateFolder: string;
	/** vault folder holding per-note changelog notes */
	changelogFolder: string;
	markReadMode: MarkReadMode;
	dwellSeconds: number;
	/** extra folders to never track (state/changelog folders are always excluded) */
	excludedFolders: string[];
	showFolderCounts: boolean;
	showBanner: boolean;
}

export const DEFAULT_SETTINGS: UnreadChangesSettings = {
	stateFolder: "_unread/state",
	changelogFolder: "_changelog",
	markReadMode: "dwell",
	dwellSeconds: 3,
	excludedFolders: [],
	showFolderCounts: true,
	showBanner: true,
};

/** Folders that must never be tracked: the exact state + changelog folders, plus user extras. */
export function effectiveExclusions(settings: UnreadChangesSettings): string[] {
	const folders = new Set<string>();
	for (const folder of [settings.stateFolder, settings.changelogFolder, ...settings.excludedFolders]) {
		const trimmed = folder.trim().replace(/\/+$/, "");
		if (trimmed) folders.add(trimmed);
	}
	return [...folders];
}

export class UnreadChangesSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: UnreadChangesPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Device name")
			.setDesc("Shown in attribution for reads/edits from this device (stored on this device only).")
			.addText((text) =>
				text.setValue(this.plugin.getDeviceName()).onChange((value) => {
					this.plugin.setDeviceName(value);
				}),
			);

		new Setting(containerEl)
			.setName("Mark as read")
			.setDesc("How a note gets marked read when you view it.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ dwell: "After viewing a few seconds", instant: "As soon as opened", manual: "Only manually" })
					.setValue(this.plugin.settings.markReadMode)
					.onChange(async (value) => {
						this.plugin.settings.markReadMode = value as MarkReadMode;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Dwell time (seconds)")
			.setDesc("Seconds a note must stay open before it counts as read (dwell mode).")
			.addSlider((slider) =>
				slider
					.setLimits(1, 30, 1)
					.setValue(this.plugin.settings.dwellSeconds)
					.onChange(async (value) => {
						this.plugin.settings.dwellSeconds = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Show folder unread counts")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showFolderCounts).onChange(async (value) => {
					this.plugin.settings.showFolderCounts = value;
					await this.plugin.saveSettings();
					this.plugin.controller?.emitChanged();
				}),
			);

		new Setting(containerEl)
			.setName("Show banner on changed notes")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showBanner).onChange(async (value) => {
					this.plugin.settings.showBanner = value;
					await this.plugin.saveSettings();
					this.plugin.controller?.emitChanged();
				}),
			);

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc("One folder per line; notes inside are never tracked. The state and changelog folders are always excluded.")
			.addTextArea((text) =>
				text
					.setValue(this.plugin.settings.excludedFolders.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.excludedFolders = value
							.split("\n")
							.map((s) => s.trim())
							.filter(Boolean);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Changelog folder")
			.setDesc("Vault folder where per-note changelogs live.")
			.addText((text) =>
				text.setValue(this.plugin.settings.changelogFolder).onChange(async (value) => {
					this.plugin.settings.changelogFolder = value.replace(/\/+$/, "") || "_changelog";
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Read-state folder")
			.setDesc("Vault folder where per-device read-state files live. Must be a visible folder (outside the config folder) so it syncs.")
			.addText((text) =>
				text.setValue(this.plugin.settings.stateFolder).onChange(async (value) => {
					this.plugin.settings.stateFolder = value.replace(/\/+$/, "") || "_unread/state";
					await this.plugin.saveSettings();
				}),
			);
	}
}
