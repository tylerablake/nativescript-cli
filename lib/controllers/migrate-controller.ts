import * as path from "path";
import * as semver from "semver";
import * as constants from "../constants";
import * as glob from "glob";
import { UpdateControllerBase } from "./update-controller-base";
import { fromWindowsRelativePathToUnix, getHash } from "../common/helpers";

export class MigrateController extends UpdateControllerBase implements IMigrateController {
	private static COMMON_MIGRATE_MESSAGE = "not affect the codebase of the application and you might need to do additional changes manually – for more information, refer to the instructions in the following blog post: https://www.nativescript.org/blog/nativescript-6.0-application-migration";
	private static UNABLE_TO_MIGRATE_APP_ERROR = `The current application is not compatible with NativeScript CLI 6.0.
Use the \`tns migrate\` command to migrate the app dependencies to a form compatible with NativeScript 6.0.
Running this command will ${MigrateController.COMMON_MIGRATE_MESSAGE}`;
	private static MIGRATE_FINISH_MESSAGE = `The \`tns migrate\` command does ${MigrateController.COMMON_MIGRATE_MESSAGE}`;

	constructor(
		protected $fs: IFileSystem,
		protected $platformCommandHelper: IPlatformCommandHelper,
		protected $platformsDataService: IPlatformsDataService,
		protected $packageInstallationManager: IPackageInstallationManager,
		protected $packageManager: IPackageManager,
		protected $pacoteService: IPacoteService,
		private $androidResourcesMigrationService: IAndroidResourcesMigrationService,
		private $devicePlatformsConstants: Mobile.IDevicePlatformsConstants,
		private $logger: ILogger,
		private $errors: IErrors,
		private $addPlatformService: IAddPlatformService,
		private $pluginsService: IPluginsService,
		private $projectDataService: IProjectDataService,
		private $platformValidationService: IPlatformValidationService,
		private $resources: IResourceLoader,
		private $injector: IInjector,
		private $settingsService: ISettingsService,
		private $staticConfig: Config.IStaticConfig) {
		super($fs, $platformCommandHelper, $platformsDataService, $packageInstallationManager, $packageManager, $pacoteService);
	}

	static readonly typescriptPackageName: string = "typescript";
	static readonly backupFolder: string = ".migration_backup";
	static readonly migrateFailMessage: string = "Could not migrate the project!";
	static readonly backupFailMessage: string = "Could not backup project folders!";

	static readonly folders: string[] = [
		constants.LIB_DIR_NAME,
		constants.HOOKS_DIR_NAME,
		constants.WEBPACK_CONFIG_NAME,
		constants.PACKAGE_JSON_FILE_NAME,
		constants.PACKAGE_LOCK_JSON_FILE_NAME,
		constants.TSCCONFIG_TNS_JSON_NAME,
		constants.KARMA_CONFIG_NAME
	];

	private get $jsonFileSettingsService(): IJsonFileSettingsService {
		const cliVersion = semver.coerce(this.$staticConfig.version);
		const shouldMigrateCacheFilePath = path.join(this.$settingsService.getProfileDir(), `should-migrate-cache-${cliVersion}.json`);
		return this.$injector.resolve("jsonFileSettingsService", { jsonFileSettingsPath: shouldMigrateCacheFilePath });
	}

	private migrationDependencies: IMigrationDependency[] = [
		{ packageName: constants.TNS_CORE_MODULES_NAME, verifiedVersion: "6.0.1" },
		{ packageName: constants.TNS_CORE_MODULES_WIDGETS_NAME, verifiedVersion: "6.0.1" },
		{ packageName: "tns-platform-declarations", isDev: true, verifiedVersion: "6.0.1" },
		{ packageName: "node-sass", isDev: true, verifiedVersion: "4.12.0" },
		{ packageName: "nativescript-dev-sass", isDev: true, replaceWith: "node-sass" },
		{ packageName: "nativescript-dev-typescript", isDev: true, replaceWith: MigrateController.typescriptPackageName },
		{ packageName: "nativescript-dev-less", isDev: true, shouldRemove: true, warning: "LESS CSS is not supported out of the box. In order to enable it, follow the steps in this feature request: https://github.com/NativeScript/nativescript-dev-webpack/issues/967" },
		{ packageName: constants.WEBPACK_PLUGIN_NAME, isDev: true, shouldAddIfMissing: true, verifiedVersion: "1.0.1" },
		{ packageName: "nativescript-camera", verifiedVersion: "4.5.0" },
		{ packageName: "nativescript-geolocation", verifiedVersion: "5.1.0" },
		{ packageName: "nativescript-imagepicker", verifiedVersion: "6.2.0" },
		{ packageName: "nativescript-social-share", verifiedVersion: "1.5.2" },
		{ packageName: "nativescript-ui-chart", verifiedVersion: "5.0.0" },
		{ packageName: "nativescript-ui-dataform", verifiedVersion: "5.0.0" },
		{ packageName: "nativescript-ui-gauge", verifiedVersion: "5.0.0" },
		{ packageName: "nativescript-ui-listview", verifiedVersion: "7.0.0" },
		{ packageName: "nativescript-ui-sidedrawer", verifiedVersion: "7.0.0" },
		{ packageName: "nativescript-ui-calendar", verifiedVersion: "5.0.0" },
		{ packageName: "nativescript-ui-autocomplete", verifiedVersion: "5.0.0" },
		{ packageName: "nativescript-datetimepicker", verifiedVersion: "1.1.0" },
		{ packageName: "kinvey-nativescript-sdk", verifiedVersion: "4.2.1" },
		{ packageName: "nativescript-plugin-firebase", verifiedVersion: "9.0.2" },
		{
			packageName: "nativescript-vue", verifiedVersion: "2.3.0",
			shouldMigrateAction: async (projectData: IProjectData, allowInvalidVersions: boolean) => {
				const dependency = { packageName: "nativescript-vue", verifiedVersion: "2.3.0", isDev: false };
				const result = this.hasDependency(dependency, projectData) && await this.shouldMigrateDependencyVersion(dependency, projectData, allowInvalidVersions);
				return result;
			},
			migrateAction: this.migrateNativeScriptVue.bind(this)
		},
		{
			packageName: "nativescript-angular", verifiedVersion: "8.0.2",
			shouldMigrateAction: async (projectData: IProjectData, allowInvalidVersions: boolean) => {
				const dependency = { packageName: "nativescript-angular", verifiedVersion: "8.0.2", isDev: false };
				const result = this.hasDependency(dependency, projectData) && await this.shouldMigrateDependencyVersion(dependency, projectData, allowInvalidVersions);
				return result;
			},
			migrateAction: this.migrateNativeScriptAngular.bind(this)
		},
		{ packageName: "nativescript-permissions", verifiedVersion: "1.3.0" },
		{ packageName: "nativescript-cardview", verifiedVersion: "3.2.0" },
		{
			packageName: "nativescript-unit-test-runner", verifiedVersion: "0.7.0",
			shouldMigrateAction: async (projectData: IProjectData, allowInvalidVersions: boolean) => {
				const dependency = { packageName: "nativescript-unit-test-runner", verifiedVersion: "0.7.0", isDev: false };
				const result = this.hasDependency(dependency, projectData) && await this.shouldMigrateDependencyVersion(dependency, projectData, allowInvalidVersions);
				return result;
			},
			migrateAction: this.migrateUnitTestRunner.bind(this)
		},
		{ packageName: MigrateController.typescriptPackageName, isDev: true, verifiedVersion: "3.4.5" },
		{ packageName: "nativescript-localize", verifiedVersion: "4.2.0" },
		{ packageName: "nativescript-dev-babel", verifiedVersion: "0.2.1" },
		{ packageName: "nativescript-nfc", verifiedVersion: "4.0.1" }
	];

	get verifiedPlatformVersions(): IDictionary<string> {
		return {
			[this.$devicePlatformsConstants.Android.toLowerCase()]: "6.0.0",
			[this.$devicePlatformsConstants.iOS.toLowerCase()]: "6.0.1"
		};
	}

	public async migrate({ projectDir, platforms, allowInvalidVersions = false }: IMigrationData): Promise<void> {
		const projectData = this.$projectDataService.getProjectData(projectDir);
		const backupDir = path.join(projectDir, MigrateController.backupFolder);

		try {
			this.$logger.info("Backup project configuration.");
			this.backup(MigrateController.folders, backupDir, projectData.projectDir);
			this.$logger.info("Backup project configuration complete.");
		} catch (error) {
			this.$logger.error(MigrateController.backupFailMessage);
			this.$fs.deleteDirectory(backupDir);
			return;
		}

		try {
			this.$logger.info("Clean auto-generated files.");
			this.handleAutoGeneratedFiles(backupDir, projectData);
			this.$logger.info("Clean auto-generated files complete.");
		} catch (error) {
			this.$logger.trace(`Error during auto-generated files handling. ${(error && error.message) || error}`);
		}

		await this.migrateOldAndroidAppResources(projectData, backupDir);

		try {
			await this.cleanUpProject(projectData);
			await this.migrateDependencies(projectData, platforms, allowInvalidVersions);
		} catch (error) {
			this.restoreBackup(MigrateController.folders, backupDir, projectData.projectDir);
			this.$errors.fail(`${MigrateController.migrateFailMessage} The error is: ${error}`);
		}

		this.$logger.info(MigrateController.MIGRATE_FINISH_MESSAGE);
	}

	public async shouldMigrate({ projectDir, platforms, allowInvalidVersions = false }: IMigrationData): Promise<boolean> {
		const remainingPlatforms = [];
		let shouldMigrate = false;

		for (const platform of platforms) {
			const cachedResult = await this.getCachedShouldMigrate(projectDir, platform);
			if (cachedResult !== false) {
				remainingPlatforms.push(platform);
			}
		}

		if (remainingPlatforms.length > 0) {
			shouldMigrate = await this._shouldMigrate({ projectDir, platforms: remainingPlatforms, allowInvalidVersions });

			if (!shouldMigrate) {
				for (const remainingPlatform of remainingPlatforms) {
					await this.setCachedShouldMigrate(projectDir, remainingPlatform);
				}
			}
		}

		return shouldMigrate;
	}

	private async _shouldMigrate({ projectDir, platforms, allowInvalidVersions }: IMigrationData): Promise<boolean> {
		const projectData = this.$projectDataService.getProjectData(projectDir);
		const shouldMigrateCommonMessage = "The app is not compatible with this CLI version and it should be migrated. Reason: ";

		for (let i = 0; i < this.migrationDependencies.length; i++) {
			const dependency = this.migrationDependencies[i];
			const hasDependency = this.hasDependency(dependency, projectData);

			if (hasDependency && dependency.shouldMigrateAction && await dependency.shouldMigrateAction(projectData, allowInvalidVersions)) {
				this.$logger.trace(`${shouldMigrateCommonMessage}'${dependency.packageName}' requires an update.`);
				return true;
			}

			if (hasDependency && (dependency.replaceWith || dependency.shouldRemove)) {
				this.$logger.trace(`${shouldMigrateCommonMessage}'${dependency.packageName}' is deprecated.`);
				return true;
			}

			if (hasDependency && await this.shouldMigrateDependencyVersion(dependency, projectData, allowInvalidVersions)) {
				this.$logger.trace(`${shouldMigrateCommonMessage}'${dependency.packageName}' should be updated.`);
				return true;
			}

			if (!hasDependency && dependency.shouldAddIfMissing) {
				this.$logger.trace(`${shouldMigrateCommonMessage}'${dependency.packageName}' is missing.`);
				return true;
			}
		}

		for (let platform of platforms) {
			platform = platform && platform.toLowerCase();
			if (!this.$platformValidationService.isValidPlatform(platform, projectData)) {
				continue;
			}

			const hasRuntimeDependency = this.hasRuntimeDependency({ platform, projectData });
			if (hasRuntimeDependency && await this.shouldUpdateRuntimeVersion(this.verifiedPlatformVersions[platform.toLowerCase()], platform, projectData, allowInvalidVersions)) {
				this.$logger.trace(`${shouldMigrateCommonMessage}Platform '${platform}' should be updated.`);
				return true;
			}
		}
	}

	public async validate({ projectDir, platforms, allowInvalidVersions = true }: IMigrationData): Promise<void> {
		const shouldMigrate = await this.shouldMigrate({ projectDir, platforms, allowInvalidVersions });
		if (shouldMigrate) {
			this.$errors.fail(MigrateController.UNABLE_TO_MIGRATE_APP_ERROR);
		}
	}

	private async getCachedShouldMigrate(projectDir: string, platform: string): Promise<boolean> {
		let cachedShouldMigrateValue = null;

		const cachedHash = await this.$jsonFileSettingsService.getSettingValue(getHash(`${projectDir}${platform.toLowerCase()}`));
		const packageJsonHash = await this.getPachageJsonHash(projectDir);
		if (cachedHash === packageJsonHash) {
			cachedShouldMigrateValue = false;
		}

		return cachedShouldMigrateValue;
	}

	private async setCachedShouldMigrate(projectDir: string, platform: string): Promise<void> {
		const packageJsonHash = await this.getPachageJsonHash(projectDir);
		await this.$jsonFileSettingsService.saveSetting(getHash(`${projectDir}${platform.toLowerCase()}`), packageJsonHash);
	}

	private async getPachageJsonHash(projectDir: string) {
		const projectPackageJsonFilePath = path.join(projectDir, constants.PACKAGE_JSON_FILE_NAME);
		return await this.$fs.getFileShasum(projectPackageJsonFilePath);
	}

	private async migrateOldAndroidAppResources(projectData: IProjectData, backupDir: string) {
		const appResourcesPath = projectData.getAppResourcesDirectoryPath();
		if (!this.$androidResourcesMigrationService.hasMigrated(appResourcesPath)) {
			this.$logger.info("Migrate old Android App_Resources structure.");
			try {
				await this.$androidResourcesMigrationService.migrate(appResourcesPath, backupDir);
			} catch (error) {
				this.$logger.warn("Migrate old Android App_Resources structure failed: ", error.message);
			}
		}
	}

	private async cleanUpProject(projectData: IProjectData): Promise<void> {
		this.$logger.info("Clean old project artefacts.");
		this.$projectDataService.removeNSConfigProperty(projectData.projectDir, "useLegacyWorkflow");
		this.$fs.deleteDirectory(path.join(projectData.projectDir, constants.HOOKS_DIR_NAME));
		this.$fs.deleteDirectory(path.join(projectData.projectDir, constants.PLATFORMS_DIR_NAME));
		this.$fs.deleteDirectory(path.join(projectData.projectDir, constants.NODE_MODULES_FOLDER_NAME));
		this.$fs.deleteFile(path.join(projectData.projectDir, constants.WEBPACK_CONFIG_NAME));
		this.$fs.deleteFile(path.join(projectData.projectDir, constants.PACKAGE_LOCK_JSON_FILE_NAME));
		if (!projectData.isShared) {
			this.$fs.deleteFile(path.join(projectData.projectDir, constants.TSCCONFIG_TNS_JSON_NAME));
		}

		this.$logger.info("Clean old project artefacts complete.");
	}

	private handleAutoGeneratedFiles(backupDir: string, projectData: IProjectData): void {
		const globOptions: glob.IOptions = {
			silent: true,
			nocase: true,
			matchBase: true,
			nodir: true,
			absolute: false,
			cwd: projectData.appDirectoryPath
		};

		const jsFiles = glob.sync("*.@(js|ts|js.map)", globOptions);
		const autoGeneratedJsFiles = this.getGeneratedFiles(jsFiles, [".js"], [".ts"]);
		const autoGeneratedJsMapFiles = this.getGeneratedFiles(jsFiles, [".map"], [""]);
		const cssFiles = glob.sync("*.@(le|sa|sc|c)ss", globOptions);
		const autoGeneratedCssFiles = this.getGeneratedFiles(cssFiles, [".css"], [".scss", ".sass", ".less"]);

		const allGeneratedFiles = autoGeneratedJsFiles.concat(autoGeneratedJsMapFiles).concat(autoGeneratedCssFiles);
		for (const generatedFile of allGeneratedFiles) {
			const sourceFile = path.join(projectData.appDirectoryPath, generatedFile);
			const destinationFile = path.join(backupDir, generatedFile);
			const destinationFileDir = path.dirname(destinationFile);
			this.$fs.ensureDirectoryExists(destinationFileDir);
			this.$fs.rename(sourceFile, destinationFile);
		}
	}

	private getGeneratedFiles(allFiles: string[], generatedFileExts: string[], sourceFileExts: string[]): string[] {
		const autoGeneratedFiles = allFiles.filter(file => {
			let isGenerated = false;
			const { dir, name, ext } = path.parse(file);
			if (generatedFileExts.indexOf(ext) > -1) {
				for (const sourceExt of sourceFileExts) {
					const possibleSourceFile = path.format({ dir, name, ext: sourceExt });
					isGenerated = allFiles.indexOf(possibleSourceFile) > -1;
					if (isGenerated) {
						break;
					}
				}
			}

			return isGenerated;
		});

		return autoGeneratedFiles;
	}

	private async migrateDependencies(projectData: IProjectData, platforms: string[], allowInvalidVersions: boolean): Promise<void> {
		this.$logger.info("Start dependencies migration.");
		for (let i = 0; i < this.migrationDependencies.length; i++) {
			const dependency = this.migrationDependencies[i];
			const hasDependency = this.hasDependency(dependency, projectData);

			if (hasDependency && dependency.migrateAction && await dependency.shouldMigrateAction(projectData, allowInvalidVersions)) {
				const newDependencies = await dependency.migrateAction(projectData, path.join(projectData.projectDir, MigrateController.backupFolder));
				for (const newDependency of newDependencies) {
					await this.migrateDependency(newDependency, projectData, allowInvalidVersions);
				}
			}

			await this.migrateDependency(dependency, projectData, allowInvalidVersions);
		}

		for (const platform of platforms) {
			const lowercasePlatform = platform.toLowerCase();
			const hasRuntimeDependency = this.hasRuntimeDependency({ platform, projectData });
			if (hasRuntimeDependency && await this.shouldUpdateRuntimeVersion(this.verifiedPlatformVersions[lowercasePlatform], platform, projectData, allowInvalidVersions)) {
				const verifiedPlatformVersion = this.verifiedPlatformVersions[lowercasePlatform];
				const platformData = this.$platformsDataService.getPlatformData(lowercasePlatform, projectData);
				this.$logger.info(`Updating ${platform} platform to version '${verifiedPlatformVersion}'.`);
				await this.$addPlatformService.setPlatformVersion(platformData, projectData, verifiedPlatformVersion);
			}
		}

		this.$logger.info("Install packages.");
		await this.$packageManager.install(projectData.projectDir, projectData.projectDir, {
			disableNpmInstall: false,
			frameworkPath: null,
			ignoreScripts: false,
			path: projectData.projectDir
		});

		this.$logger.info("Migration complete.");
	}

	private async migrateDependency(dependency: IMigrationDependency, projectData: IProjectData, allowInvalidVersions: boolean): Promise<void> {
		const hasDependency = this.hasDependency(dependency, projectData);
		if (hasDependency && dependency.warning) {
			this.$logger.warn(dependency.warning);
		}

		if (hasDependency && (dependency.replaceWith || dependency.shouldRemove)) {
			this.$pluginsService.removeFromPackageJson(dependency.packageName, projectData.projectDir);
			if (dependency.replaceWith) {
				const replacementDep = _.find(this.migrationDependencies, migrationPackage => migrationPackage.packageName === dependency.replaceWith);
				if (!replacementDep) {
					this.$errors.fail("Failed to find replacement dependency.");
				}

				this.$logger.info(`Replacing '${dependency.packageName}' with '${replacementDep.packageName}'.`);
				this.$pluginsService.addToPackageJson(replacementDep.packageName, replacementDep.verifiedVersion, replacementDep.isDev, projectData.projectDir);
			}

			return;
		}

		if (hasDependency && await this.shouldMigrateDependencyVersion(dependency, projectData, allowInvalidVersions)) {
			this.$logger.info(`Updating '${dependency.packageName}' to compatible version '${dependency.verifiedVersion}'`);
			this.$pluginsService.addToPackageJson(dependency.packageName, dependency.verifiedVersion, dependency.isDev, projectData.projectDir);
			return;
		}

		if (!hasDependency && dependency.shouldAddIfMissing) {
			this.$logger.info(`Adding '${dependency.packageName}' with version '${dependency.verifiedVersion}'`);
			this.$pluginsService.addToPackageJson(dependency.packageName, dependency.verifiedVersion, dependency.isDev, projectData.projectDir);
		}
	}

	private async shouldMigrateDependencyVersion(dependency: IMigrationDependency, projectData: IProjectData, allowInvalidVersions: boolean): Promise<boolean> {
		const installedVersion = await this.$packageInstallationManager.getInstalledDependencyVersion(dependency.packageName, projectData.projectDir);
		const requiredVersion = dependency.verifiedVersion;

		return this.isOutdatedVersion(installedVersion, requiredVersion, allowInvalidVersions);
	}

	private async shouldUpdateRuntimeVersion(targetVersion: string, platform: string, projectData: IProjectData, allowInvalidVersions: boolean): Promise<boolean> {
		const installedVersion = await this.getMaxRuntimeVersion({ platform, projectData });

		return this.isOutdatedVersion(installedVersion, targetVersion, allowInvalidVersions);
	}

	private isOutdatedVersion(version: string, targetVersion: string, allowInvalidVersions: boolean): boolean {
		return !!version ? semver.lt(version, targetVersion) : !allowInvalidVersions;
	}

	private async migrateUnitTestRunner(projectData: IProjectData, migrationBackupDirPath: string): Promise<IMigrationDependency[]> {
		// Migrate karma.conf.js
		const pathToKarmaConfig = path.join(migrationBackupDirPath, constants.KARMA_CONFIG_NAME);
		if (this.$fs.exists(pathToKarmaConfig)) {
			const oldKarmaContent = this.$fs.readText(pathToKarmaConfig);

			const regExp = /frameworks:\s+\[([\S\s]*?)\]/g;
			const matches = regExp.exec(oldKarmaContent);
			const frameworks = (matches && matches[1] && matches[1].trim()) || '["jasmine"]';

			const testsDir = path.join(projectData.appDirectoryPath, 'tests');
			const relativeTestsDir = path.relative(projectData.projectDir, testsDir);
			const testFiles = `'${fromWindowsRelativePathToUnix(relativeTestsDir)}/**/*.*'`;

			const karmaConfTemplate = this.$resources.readText('test/karma.conf.js');
			const karmaConf = _.template(karmaConfTemplate)({ frameworks, testFiles });
			this.$fs.writeFile(path.join(projectData.projectDir, constants.KARMA_CONFIG_NAME), karmaConf);
		}

		// Dependencies to migrate
		const dependencies = [
			{ packageName: "karma-webpack", verifiedVersion: "3.0.5", isDev: true, shouldAddIfMissing: true },
			{ packageName: "karma-jasmine", verifiedVersion: "2.0.1", isDev: true },
			{ packageName: "karma-mocha", verifiedVersion: "1.3.0", isDev: true },
			{ packageName: "karma-chai", verifiedVersion: "0.1.0", isDev: true },
			{ packageName: "karma-qunit", verifiedVersion: "3.1.2", isDev: true },
			{ packageName: "karma", verifiedVersion: "4.1.0", isDev: true },
		];

		return dependencies;
	}

	private async migrateNativeScriptAngular(): Promise<IMigrationDependency[]> {
		const dependencies = [
			{ packageName: "@angular/platform-browser-dynamic", verifiedVersion: "8.0.0", shouldAddIfMissing: true },
			{ packageName: "@angular/common", verifiedVersion: "8.0.0", shouldAddIfMissing: true },
			{ packageName: "@angular/compiler", verifiedVersion: "8.0.0", shouldAddIfMissing: true },
			{ packageName: "@angular/core", verifiedVersion: "8.0.0", shouldAddIfMissing: true },
			{ packageName: "@angular/forms", verifiedVersion: "8.0.0", shouldAddIfMissing: true },
			{ packageName: "@angular/http", verifiedVersion: "8.0.0-beta.10", shouldAddIfMissing: true },
			{ packageName: "@angular/platform-browser", verifiedVersion: "8.0.0", shouldAddIfMissing: true },
			{ packageName: "@angular/router", verifiedVersion: "8.0.0", shouldAddIfMissing: true },
			{ packageName: "rxjs", verifiedVersion: "6.3.3", shouldAddIfMissing: true },
			{ packageName: "zone.js", verifiedVersion: "0.9.1", shouldAddIfMissing: true },
			{ packageName: "@angular/animations", verifiedVersion: "8.0.0" },
			{ packageName: "@angular/compiler-cli", verifiedVersion: "8.0.0", isDev: true },
			{ packageName: "@ngtools/webpack", verifiedVersion: "8.0.0", isDev: true },
			{ packageName: "@angular-devkit/build-angular", verifiedVersion: "0.800.3", isDev: true }
		];

		return dependencies;
	}

	private async migrateNativeScriptVue(): Promise<IMigrationDependency[]> {
		const dependencies = [
			{ packageName: "nativescript-vue-template-compiler", verifiedVersion: "2.3.0", isDev: true }
		];

		return dependencies;
	}
}

$injector.register("migrateController", MigrateController);
