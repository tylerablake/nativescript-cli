import * as path from "path";
import * as shell from "shelljs";
import * as constants from "../constants";
import * as semver from "semver";
import * as projectServiceBaseLib from "./platform-project-service-base";
import { DeviceAndroidDebugBridge } from "../common/mobile/android/device-android-debug-bridge";
import { Configurations, LiveSyncPaths } from "../common/constants";
import { performanceLog } from ".././common/decorators";

export class AndroidProjectService extends projectServiceBaseLib.PlatformProjectServiceBase {
	private static VALUES_DIRNAME = "values";
	private static VALUES_VERSION_DIRNAME_PREFIX = AndroidProjectService.VALUES_DIRNAME + "-v";
	private static ANDROID_PLATFORM_NAME = "android";
	private static MIN_RUNTIME_VERSION_WITH_GRADLE = "1.5.0";

	constructor(private $androidToolsInfo: IAndroidToolsInfo,
		private $errors: IErrors,
		$fs: IFileSystem,
		private $logger: ILogger,
		$projectDataService: IProjectDataService,
		private $injector: IInjector,
		private $devicePlatformsConstants: Mobile.IDevicePlatformsConstants,
		private $androidPluginBuildService: IAndroidPluginBuildService,
		private $platformEnvironmentRequirements: IPlatformEnvironmentRequirements,
		private $androidResourcesMigrationService: IAndroidResourcesMigrationService,
		private $filesHashService: IFilesHashService,
		private $gradleCommandService: IGradleCommandService,
		private $gradleBuildService: IGradleBuildService,
		private $analyticsService: IAnalyticsService) {
		super($fs, $projectDataService);
	}

	private _platformData: IPlatformData = null;
	public getPlatformData(projectData: IProjectData): IPlatformData {
		if (!projectData && !this._platformData) {
			throw new Error("First call of getPlatformData without providing projectData.");
		}
		if (projectData && projectData.platformsDir) {
			const projectRoot = path.join(projectData.platformsDir, AndroidProjectService.ANDROID_PLATFORM_NAME);

			const appDestinationDirectoryArr = [projectRoot, constants.APP_FOLDER_NAME, constants.SRC_DIR, constants.MAIN_DIR, constants.ASSETS_DIR];
			const configurationsDirectoryArr = [projectRoot, constants.APP_FOLDER_NAME, constants.SRC_DIR, constants.MAIN_DIR, constants.MANIFEST_FILE_NAME];
			const deviceBuildOutputArr = [projectRoot, constants.APP_FOLDER_NAME, constants.BUILD_DIR, constants.OUTPUTS_DIR, constants.APK_DIR];

			const packageName = this.getProjectNameFromId(projectData);

			this._platformData = {
				frameworkPackageName: constants.TNS_ANDROID_RUNTIME_NAME,
				normalizedPlatformName: "Android",
				platformNameLowerCase: "android",
				appDestinationDirectoryPath: path.join(...appDestinationDirectoryArr),
				platformProjectService: <any>this,
				projectRoot: projectRoot,
				getBuildOutputPath: (buildOptions: IBuildOutputOptions) => {
					if (buildOptions.androidBundle) {
						return path.join(projectRoot, constants.APP_FOLDER_NAME, constants.BUILD_DIR, constants.OUTPUTS_DIR, constants.BUNDLE_DIR);
					}

					return path.join(...deviceBuildOutputArr);
				},
				getValidBuildOutputData: (buildOptions: IBuildOutputOptions): IValidBuildOutputData => {
					const buildMode = buildOptions.release ? Configurations.Release.toLowerCase() : Configurations.Debug.toLowerCase();

					if (buildOptions.androidBundle) {
						return {
							packageNames: [
								`${constants.APP_FOLDER_NAME}${constants.AAB_EXTENSION_NAME}`,
								`${constants.APP_FOLDER_NAME}-${buildMode}${constants.AAB_EXTENSION_NAME}`
							]
						};
					}

					return {
						packageNames: [
							`${packageName}-${buildMode}${constants.APK_EXTENSION_NAME}`,
							`${projectData.projectName}-${buildMode}${constants.APK_EXTENSION_NAME}`,
							`${projectData.projectName}${constants.APK_EXTENSION_NAME}`,
							`${constants.APP_FOLDER_NAME}-${buildMode}${constants.APK_EXTENSION_NAME}`

						],
						regexes: [new RegExp(`${constants.APP_FOLDER_NAME}-.*-(${Configurations.Debug}|${Configurations.Release})${constants.APK_EXTENSION_NAME}`, "i"), new RegExp(`${packageName}-.*-(${Configurations.Debug}|${Configurations.Release})${constants.APK_EXTENSION_NAME}`, "i")]
					};
				},
				configurationFileName: constants.MANIFEST_FILE_NAME,
				configurationFilePath: path.join(...configurationsDirectoryArr),
				relativeToFrameworkConfigurationFilePath: path.join(constants.SRC_DIR, constants.MAIN_DIR, constants.MANIFEST_FILE_NAME),
				fastLivesyncFileExtensions: [".jpg", ".gif", ".png", ".bmp", ".webp"] // http://developer.android.com/guide/appendix/media-formats.html
			};

		}

		return this._platformData;
	}

	public getCurrentPlatformVersion(platformData: IPlatformData, projectData: IProjectData): string {
		const currentPlatformData: IDictionary<any> = this.$projectDataService.getNSValue(projectData.projectDir, platformData.frameworkPackageName);

		return currentPlatformData && currentPlatformData[constants.VERSION_STRING];
	}

	public async validateOptions(): Promise<boolean> {
		return true;
	}

	public getAppResourcesDestinationDirectoryPath(projectData: IProjectData): string {
		const appResourcesDirStructureHasMigrated = this.$androidResourcesMigrationService.hasMigrated(projectData.getAppResourcesDirectoryPath());

		if (appResourcesDirStructureHasMigrated) {
			return this.getUpdatedAppResourcesDestinationDirPath(projectData);
		} else {
			return this.getLegacyAppResourcesDestinationDirPath(projectData);
		}
	}

	public async validate(projectData: IProjectData, options: IOptions, notConfiguredEnvOptions?: INotConfiguredEnvOptions): Promise<IValidatePlatformOutput> {
		this.validatePackageName(projectData.projectIdentifiers.android);
		this.validateProjectName(projectData.projectName);

		const checkEnvironmentRequirementsOutput = await this.$platformEnvironmentRequirements.checkEnvironmentRequirements({
			platform: this.getPlatformData(projectData).normalizedPlatformName,
			projectDir: projectData.projectDir,
			options,
			notConfiguredEnvOptions
		});

		this.$androidToolsInfo.validateTargetSdk({ showWarningsAsErrors: true, projectDir: projectData.projectDir });

		return {
			checkEnvironmentRequirementsOutput
		};
	}

	public async createProject(frameworkDir: string, frameworkVersion: string, projectData: IProjectData): Promise<void> {
		if (semver.lt(frameworkVersion, AndroidProjectService.MIN_RUNTIME_VERSION_WITH_GRADLE)) {
			this.$errors.fail(`The NativeScript CLI requires Android runtime ${AndroidProjectService.MIN_RUNTIME_VERSION_WITH_GRADLE} or later to work properly.`);
		}

		this.$fs.ensureDirectoryExists(this.getPlatformData(projectData).projectRoot);
		const androidToolsInfo = this.$androidToolsInfo.getToolsInfo({ projectDir: projectData.projectDir });
		const targetSdkVersion = androidToolsInfo && androidToolsInfo.targetSdkVersion;
		this.$logger.trace(`Using Android SDK '${targetSdkVersion}'.`);

		this.copy(this.getPlatformData(projectData).projectRoot, frameworkDir, "*", "-R");

		this.cleanResValues(targetSdkVersion, projectData);
	}

	private cleanResValues(targetSdkVersion: number, projectData: IProjectData): void {
		const resDestinationDir = this.getAppResourcesDestinationDirectoryPath(projectData);
		const directoriesInResFolder = this.$fs.readDirectory(resDestinationDir);
		const directoriesToClean = directoriesInResFolder
			.map(dir => {
				return {
					dirName: dir,
					sdkNum: parseInt(dir.substr(AndroidProjectService.VALUES_VERSION_DIRNAME_PREFIX.length))
				};
			})
			.filter(dir => dir.dirName.match(AndroidProjectService.VALUES_VERSION_DIRNAME_PREFIX)
				&& dir.sdkNum
				&& (!targetSdkVersion || (targetSdkVersion < dir.sdkNum)))
			.map(dir => path.join(resDestinationDir, dir.dirName));

		this.$logger.trace("Directories to clean:");

		this.$logger.trace(directoriesToClean);

		_.map(directoriesToClean, dir => this.$fs.deleteDirectory(dir));
	}

	public async interpolateData(projectData: IProjectData): Promise<void> {
		// Interpolate the apilevel and package
		this.interpolateConfigurationFile(projectData);
		const appResourcesDirectoryPath = projectData.getAppResourcesDirectoryPath();

		let stringsFilePath: string;

		const appResourcesDestinationDirectoryPath = this.getAppResourcesDestinationDirectoryPath(projectData);
		if (this.$androidResourcesMigrationService.hasMigrated(appResourcesDirectoryPath)) {
			stringsFilePath = path.join(appResourcesDestinationDirectoryPath, constants.MAIN_DIR, constants.RESOURCES_DIR, 'values', 'strings.xml');
		} else {
			stringsFilePath = path.join(appResourcesDestinationDirectoryPath, 'values', 'strings.xml');
		}

		shell.sed('-i', /__NAME__/, projectData.projectName, stringsFilePath);
		shell.sed('-i', /__TITLE_ACTIVITY__/, projectData.projectName, stringsFilePath);

		const gradleSettingsFilePath = path.join(this.getPlatformData(projectData).projectRoot, "settings.gradle");
		shell.sed('-i', /__PROJECT_NAME__/, this.getProjectNameFromId(projectData), gradleSettingsFilePath);

		try {
			// will replace applicationId in app/App_Resources/Android/app.gradle if it has not been edited by the user
			const appGradleContent = this.$fs.readText(projectData.appGradlePath);
			if (appGradleContent.indexOf(constants.PACKAGE_PLACEHOLDER_NAME) !== -1) {
				//TODO: For compatibility with old templates. Once all templates are updated should delete.
				shell.sed('-i', new RegExp(constants.PACKAGE_PLACEHOLDER_NAME), projectData.projectIdentifiers.android, projectData.appGradlePath);
			}
		} catch (e) {
			this.$logger.trace(`Templates updated and no need for replace in app.gradle.`);
		}
	}

	public interpolateConfigurationFile(projectData: IProjectData): void {
		const manifestPath = this.getPlatformData(projectData).configurationFilePath;
		shell.sed('-i', /__PACKAGE__/, projectData.projectIdentifiers.android, manifestPath);
	}

	private getProjectNameFromId(projectData: IProjectData): string {
		let id: string;
		if (projectData && projectData.projectIdentifiers && projectData.projectIdentifiers.android) {
			const idParts = projectData.projectIdentifiers.android.split(".");
			id = idParts[idParts.length - 1];
		}

		return id;
	}

	public afterCreateProject(projectRoot: string): void {
		return null;
	}

	public async updatePlatform(currentVersion: string, newVersion: string, canUpdate: boolean, projectData: IProjectData, addPlatform?: Function, removePlatforms?: (platforms: string[]) => Promise<void>): Promise<boolean> {
		if (semver.eq(newVersion, AndroidProjectService.MIN_RUNTIME_VERSION_WITH_GRADLE)) {
			const platformLowercase = this.getPlatformData(projectData).normalizedPlatformName.toLowerCase();
			await removePlatforms([platformLowercase.split("@")[0]]);
			await addPlatform(platformLowercase);
			return false;
		}

		return true;
	}

	@performanceLog()
	public async buildProject(projectRoot: string, projectData: IProjectData, buildData: IAndroidBuildData): Promise<void> {
		const platformData = this.getPlatformData(projectData);
		await this.$gradleBuildService.buildProject(platformData.projectRoot, buildData);

		const outputPath = platformData.getBuildOutputPath(buildData);
		await this.$filesHashService.saveHashesForProject(this._platformData, outputPath);
		await this.trackKotlinUsage(projectRoot);
	}

	public async buildForDeploy(projectRoot: string, projectData: IProjectData, buildData?: IAndroidBuildData): Promise<void> {
		return this.buildProject(projectRoot, projectData, buildData);
	}

	public isPlatformPrepared(projectRoot: string, projectData: IProjectData): boolean {
		return this.$fs.exists(path.join(this.getPlatformData(projectData).appDestinationDirectoryPath, constants.APP_FOLDER_NAME));
	}

	public getFrameworkFilesExtensions(): string[] {
		return [".jar", ".dat"];
	}

	public async prepareProject(): Promise<void> {
		// Intentionally left empty.
	}

	public ensureConfigurationFileInAppResources(projectData: IProjectData): void {
		const appResourcesDirectoryPath = projectData.appResourcesDirectoryPath;
		const appResourcesDirStructureHasMigrated = this.$androidResourcesMigrationService.hasMigrated(appResourcesDirectoryPath);
		let originalAndroidManifestFilePath;

		if (appResourcesDirStructureHasMigrated) {
			originalAndroidManifestFilePath = path.join(appResourcesDirectoryPath, this.$devicePlatformsConstants.Android, "src", "main", this.getPlatformData(projectData).configurationFileName);
		} else {
			originalAndroidManifestFilePath = path.join(appResourcesDirectoryPath, this.$devicePlatformsConstants.Android, this.getPlatformData(projectData).configurationFileName);
		}

		const manifestExists = this.$fs.exists(originalAndroidManifestFilePath);

		if (!manifestExists) {
			this.$logger.warn('No manifest found in ' + originalAndroidManifestFilePath);
			return;
		}
		// Overwrite the AndroidManifest from runtime.
		if (!appResourcesDirStructureHasMigrated) {
			this.$fs.copyFile(originalAndroidManifestFilePath, this.getPlatformData(projectData).configurationFilePath);
		}
	}

	public prepareAppResources(projectData: IProjectData): void {
		const platformData = this.getPlatformData(projectData);
		const projectAppResourcesPath = projectData.getAppResourcesDirectoryPath(projectData.projectDir);
		const platformsAppResourcesPath = this.getAppResourcesDestinationDirectoryPath(projectData);

		this.cleanUpPreparedResources(projectAppResourcesPath, projectData);

		this.$fs.ensureDirectoryExists(platformsAppResourcesPath);

		const appResourcesDirStructureHasMigrated = this.$androidResourcesMigrationService.hasMigrated(projectAppResourcesPath);
		if (appResourcesDirStructureHasMigrated) {
			this.$fs.copyFile(path.join(projectAppResourcesPath, platformData.normalizedPlatformName, constants.SRC_DIR, "*"), platformsAppResourcesPath);
		} else {
			this.$fs.copyFile(path.join(projectAppResourcesPath, platformData.normalizedPlatformName, "*"), platformsAppResourcesPath);
			// https://github.com/NativeScript/android-runtime/issues/899
			// App_Resources/Android/libs is reserved to user's aars and jars, but they should not be copied as resources
			this.$fs.deleteDirectory(path.join(platformsAppResourcesPath, "libs"));
		}
	}

	public async preparePluginNativeCode(pluginData: IPluginData, projectData: IProjectData): Promise<void> {
		// build Android plugins which contain AndroidManifest.xml and/or resources
		const pluginPlatformsFolderPath = this.getPluginPlatformsFolderPath(pluginData, AndroidProjectService.ANDROID_PLATFORM_NAME);
		if (this.$fs.exists(pluginPlatformsFolderPath)) {
			const options: IPluginBuildOptions = {
				projectDir: projectData.projectDir,
				pluginName: pluginData.name,
				platformsAndroidDirPath: pluginPlatformsFolderPath,
				aarOutputDir: pluginPlatformsFolderPath,
				tempPluginDirPath: path.join(projectData.platformsDir, "tempPlugin")
			};

			if (await this.$androidPluginBuildService.buildAar(options)) {
				this.$logger.info(`Built aar for ${options.pluginName}`);
			}

			this.$androidPluginBuildService.migrateIncludeGradle(options);
		}
	}

	public async processConfigurationFilesFromAppResources(): Promise<void> {
		return;
	}

	public async removePluginNativeCode(pluginData: IPluginData, projectData: IProjectData): Promise<void> {
		// not implemented
	}

	public async beforePrepareAllPlugins(projectData: IProjectData, dependencies?: IDependencyData[]): Promise<void> {
		if (dependencies) {
			dependencies = this.filterUniqueDependencies(dependencies);
			this.provideDependenciesJson(projectData, dependencies);
		}
	}

	public async handleNativeDependenciesChange(projectData: IProjectData, opts: IRelease): Promise<void> {
		return;
	}

	private filterUniqueDependencies(dependencies: IDependencyData[]): IDependencyData[] {
		const depsDictionary = dependencies.reduce((dict, dep) => {
			const collision = dict[dep.name];
			// in case there are multiple dependencies to the same module, the one declared in the package.json takes precedence
			if (!collision || collision.depth > dep.depth) {
				dict[dep.name] = dep;
			}
			return dict;
		}, <IDictionary<IDependencyData>>{});
		return _.values(depsDictionary);
	}

	private provideDependenciesJson(projectData: IProjectData, dependencies: IDependencyData[]): void {
		const platformDir = path.join(projectData.platformsDir, AndroidProjectService.ANDROID_PLATFORM_NAME);
		const dependenciesJsonPath = path.join(platformDir, constants.DEPENDENCIES_JSON_NAME);
		const nativeDependencies = dependencies
			.filter(AndroidProjectService.isNativeAndroidDependency)
			.map(({ name, directory }) => ({ name, directory: path.relative(platformDir, directory) }));
		const jsonContent = JSON.stringify(nativeDependencies, null, 4);

		this.$fs.writeFile(dependenciesJsonPath, jsonContent);
	}

	private static isNativeAndroidDependency({ nativescript }: IDependencyData): boolean {
		return nativescript && (nativescript.android || (nativescript.platforms && nativescript.platforms.android));
	}

	public async stopServices(projectRoot: string): Promise<ISpawnResult> {
		const result = await this.$gradleCommandService.executeCommand(["--stop", "--quiet"], {
			cwd: projectRoot,
			message: "Gradle stop services...",
			stdio: "pipe"
		});

		return result;
	}

	public async cleanProject(projectRoot: string): Promise<void> {
		await this.$gradleBuildService.cleanProject(projectRoot, <any>{ release: false });
	}

	public async cleanDeviceTempFolder(deviceIdentifier: string, projectData: IProjectData): Promise<void> {
		const adb = this.$injector.resolve(DeviceAndroidDebugBridge, { identifier: deviceIdentifier });
		const deviceRootPath = `${LiveSyncPaths.ANDROID_TMP_DIR_NAME}/${projectData.projectIdentifiers.android}`;
		await adb.executeShellCommand(["rm", "-rf", deviceRootPath]);
	}

	public async checkForChanges(): Promise<void> {
		// Nothing android specific to check yet.
	}

	public getDeploymentTarget(projectData: IProjectData): semver.SemVer { return; }

	private copy(projectRoot: string, frameworkDir: string, files: string, cpArg: string): void {
		const paths = files.split(' ').map(p => path.join(frameworkDir, p));
		shell.cp(cpArg, paths, projectRoot);
	}

	private validatePackageName(packageName: string): void {
		//Make the package conform to Java package types
		//Enforce underscore limitation
		if (!/^[a-zA-Z]+(\.[a-zA-Z0-9][a-zA-Z0-9_]*)+$/.test(packageName)) {
			this.$errors.fail("Package name must look like: com.company.Name");
		}

		//Class is a reserved word
		if (/\b[Cc]lass\b/.test(packageName)) {
			this.$errors.fail("class is a reserved word");
		}
	}

	private validateProjectName(projectName: string): void {
		if (projectName === '') {
			this.$errors.fail("Project name cannot be empty");
		}

		//Classes in Java don't begin with numbers
		if (/^[0-9]/.test(projectName)) {
			this.$errors.fail("Project name must not begin with a number");
		}
	}

	private getLegacyAppResourcesDestinationDirPath(projectData: IProjectData): string {
		const resourcePath: string[] = [constants.APP_FOLDER_NAME, constants.SRC_DIR, constants.MAIN_DIR, constants.RESOURCES_DIR];

		return path.join(this.getPlatformData(projectData).projectRoot, ...resourcePath);
	}

	private getUpdatedAppResourcesDestinationDirPath(projectData: IProjectData): string {
		const resourcePath: string[] = [constants.APP_FOLDER_NAME, constants.SRC_DIR];

		return path.join(this.getPlatformData(projectData).projectRoot, ...resourcePath);
	}

	private cleanUpPreparedResources(appResourcesDirectoryPath: string, projectData: IProjectData): void {
		let resourcesDirPath = path.join(appResourcesDirectoryPath, this.getPlatformData(projectData).normalizedPlatformName);
		if (this.$androidResourcesMigrationService.hasMigrated(projectData.appResourcesDirectoryPath)) {
			resourcesDirPath = path.join(resourcesDirPath, constants.MAIN_DIR, constants.RESOURCES_DIR);
		}

		const valuesDirRegExp = /^values/;
		if (this.$fs.exists(resourcesDirPath)) {
			const resourcesDirs = this.$fs.readDirectory(resourcesDirPath).filter(resDir => !resDir.match(valuesDirRegExp));
			const appResourcesDestinationDirectoryPath = this.getAppResourcesDestinationDirectoryPath(projectData);
			_.each(resourcesDirs, resourceDir => {
				this.$fs.deleteDirectory(path.join(appResourcesDestinationDirectoryPath, resourceDir));
			});
		}
	}

	private async trackKotlinUsage(projectRoot: string): Promise<void> {
		const buildStatistics = this.tryGetAndroidBuildStatistics(projectRoot);

		try {
			if (buildStatistics && buildStatistics.kotlinUsage) {
				const analyticsDelimiter = constants.AnalyticsEventLabelDelimiter;
				const hasUseKotlinPropertyInAppData = `hasUseKotlinPropertyInApp${analyticsDelimiter}${buildStatistics.kotlinUsage.hasUseKotlinPropertyInApp}`;
				const hasKotlinRuntimeClassesData = `hasKotlinRuntimeClasses${analyticsDelimiter}${buildStatistics.kotlinUsage.hasKotlinRuntimeClasses}`;
				await this.$analyticsService.trackEventActionInGoogleAnalytics({
					action: constants.TrackActionNames.UsingKotlin,
					additionalData: `${hasUseKotlinPropertyInAppData}${analyticsDelimiter}${hasKotlinRuntimeClassesData}`
				});
			}
		} catch (e) {
			this.$logger.trace(`Failed to track android build statistics. Error is: ${e.message}`);
		}
	}

	private tryGetAndroidBuildStatistics(projectRoot: string): Object {
		const staticsFilePath = path.join(projectRoot, constants.ANDROID_ANALYTICS_DATA_DIR, constants.ANDROID_ANALYTICS_DATA_FILE);
		let buildStatistics;

		if (this.$fs.exists(staticsFilePath)) {
			try {
				buildStatistics = this.$fs.readJson(staticsFilePath);
			} catch (e) {
				this.$logger.trace(`Unable to read android build statistics file. Error is ${e.message}`);
			}
		}

		return buildStatistics;
	}
}

$injector.register("androidProjectService", AndroidProjectService);
