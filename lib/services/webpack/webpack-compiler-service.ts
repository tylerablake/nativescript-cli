import * as path from "path";
import * as child_process from "child_process";
import * as semver from "semver";
import { EventEmitter } from "events";
import { performanceLog } from "../../common/decorators";
import { WEBPACK_COMPILATION_COMPLETE, WEBPACK_PLUGIN_NAME } from "../../constants";

export class WebpackCompilerService extends EventEmitter implements IWebpackCompilerService {
	private webpackProcesses: IDictionary<child_process.ChildProcess> = {};
	private expectedHashes: IStringDictionary = {};

	constructor(
		private $errors: IErrors,
		private $childProcess: IChildProcess,
		public $hooksService: IHooksService,
		public $hostInfo: IHostInfo,
		private $logger: ILogger,
		private $mobileHelper: Mobile.IMobileHelper,
		private $cleanupService: ICleanupService,
		private $packageInstallationManager: IPackageInstallationManager
	) { super(); }

	public async compileWithWatch(platformData: IPlatformData, projectData: IProjectData, prepareData: IPrepareData): Promise<any> {
		return new Promise(async (resolve, reject) => {
			if (this.webpackProcesses[platformData.platformNameLowerCase]) {
				resolve();
				return;
			}

			let isFirstWebpackWatchCompilation = true;
			prepareData.watch = true;
			try {
				const childProcess = await this.startWebpackProcess(platformData, projectData, prepareData);

				childProcess.on("message", (message: string | IWebpackEmitMessage) => {
					if (message === "Webpack compilation complete.") {
						this.$logger.info("Webpack build done!");
						resolve(childProcess);
					}

					message = message as IWebpackEmitMessage;
					if (message.emittedFiles) {
						if (isFirstWebpackWatchCompilation) {
							isFirstWebpackWatchCompilation = false;
							this.expectedHashes[platformData.platformNameLowerCase] = message.hash;
							return;
						}

						let result;

						if (prepareData.hmr) {
							result = this.getUpdatedEmittedFiles(message.emittedFiles, message.chunkFiles, message.hash, platformData.platformNameLowerCase);
						} else {
							result = { emittedFiles: message.emittedFiles, fallbackFiles: <string[]>[], hash: "" };
						}

						const files = result.emittedFiles
							.map((file: string) => path.join(platformData.appDestinationDirectoryPath, "app", file));
						const fallbackFiles = result.fallbackFiles
							.map((file: string) => path.join(platformData.appDestinationDirectoryPath, "app", file));

						const data = {
							files,
							hasOnlyHotUpdateFiles: files.every(f => f.indexOf("hot-update") > -1),
							hmrData: {
								hash: result.hash,
								fallbackFiles
							},
							platform: platformData.platformNameLowerCase
						};

						if (data.files.length) {
							this.emit(WEBPACK_COMPILATION_COMPLETE, data);
						}
					}
				});

				childProcess.on("error", (err) => {
					this.$logger.trace(`Unable to start webpack process in watch mode. Error is: ${err}`);
					delete this.webpackProcesses[platformData.platformNameLowerCase];
					reject(err);
				});

				childProcess.on("close", async (arg: any) => {
					await this.$cleanupService.removeKillProcess(childProcess.pid.toString());

					const exitCode = typeof arg === "number" ? arg : arg && arg.code;
					this.$logger.trace(`Webpack process exited with code ${exitCode} when we expected it to be long living with watch.`);
					const error = new Error(`Executing webpack failed with exit code ${exitCode}.`);
					error.code = exitCode;
					delete this.webpackProcesses[platformData.platformNameLowerCase];
					reject(error);
				});
			} catch (err) {
				reject(err);
			}
		});
	}

	public async compileWithoutWatch(platformData: IPlatformData, projectData: IProjectData, prepareData: IPrepareData): Promise<void> {
		return new Promise(async (resolve, reject) => {
			if (this.webpackProcesses[platformData.platformNameLowerCase]) {
				resolve();
				return;
			}

			try {
				const childProcess = await this.startWebpackProcess(platformData, projectData, prepareData);
				childProcess.on("error", (err) => {
					this.$logger.trace(`Unable to start webpack process in non-watch mode. Error is: ${err}`);
					delete this.webpackProcesses[platformData.platformNameLowerCase];
					reject(err);
				});

				childProcess.on("close", async (arg: any) => {
					await this.$cleanupService.removeKillProcess(childProcess.pid.toString());

					delete this.webpackProcesses[platformData.platformNameLowerCase];
					const exitCode = typeof arg === "number" ? arg : arg && arg.code;
					if (exitCode === 0) {
						resolve();
					} else {
						const error = new Error(`Executing webpack failed with exit code ${exitCode}.`);
						error.code = exitCode;
						reject(error);
					}
				});
			} catch (err) {
				reject(err);
			}
		});
	}

	public async stopWebpackCompiler(platform: string): Promise<void> {
		if (platform) {
			await this.stopWebpackForPlatform(platform);
		} else {
			const webpackedPlatforms = Object.keys(this.webpackProcesses);

			for (let i = 0; i < webpackedPlatforms.length; i++) {
				await this.stopWebpackForPlatform(webpackedPlatforms[i]);
			}
		}
	}

	@performanceLog()
	private async startWebpackProcess(platformData: IPlatformData, projectData: IProjectData, prepareData: IPrepareData): Promise<child_process.ChildProcess> {
		const envData = this.buildEnvData(platformData.platformNameLowerCase, projectData, prepareData);
		const envParams = await this.buildEnvCommandLineParams(envData, platformData, projectData, prepareData);
		const additionalNodeArgs = semver.major(process.version) <= 8 ? ["--harmony"] : [];

		const args = [
			...additionalNodeArgs,
			"--preserve-symlinks",
			path.join(projectData.projectDir, "node_modules", "webpack", "bin", "webpack.js"),
			`--config=${path.join(projectData.projectDir, "webpack.config.js")}`,
			...envParams
		];

		if (process.arch === "x64") {
			args.unshift("--max_old_space_size=4096");
		}

		if (prepareData.watch) {
			args.push("--watch");
		}

		const stdio = prepareData.watch ? ["inherit", "inherit", "inherit", "ipc"] : "inherit";
		const childProcess = this.$childProcess.spawn(process.execPath, args, { cwd: projectData.projectDir, stdio });

		this.webpackProcesses[platformData.platformNameLowerCase] = childProcess;
		await this.$cleanupService.addKillProcess(childProcess.pid.toString());

		return childProcess;
	}

	private buildEnvData(platform: string, projectData: IProjectData, prepareData: IPrepareData) {
		const { env } = prepareData;
		const envData = Object.assign({},
			env,
			{ [platform.toLowerCase()]: true }
		);

		const appPath = projectData.getAppDirectoryRelativePath();
		const appResourcesPath = projectData.getAppResourcesRelativeDirectoryPath();

		Object.assign(envData,
			appPath && { appPath },
			appResourcesPath && { appResourcesPath }
		);

		envData.verbose = envData.verbose || this.$logger.isVerbose();
		envData.production = envData.production || prepareData.release;
		// The snapshot generation is wrongly located in the Webpack plugin.
		// It should be moved in the Native Prepare of the CLI or a Gradle task in the Runtime.
		// As a workaround, we skip the mksnapshot, xxd and android-ndk calls based on skipNativePrepare.
		// In this way the plugin will prepare only the snapshot JS entry without any native prepare and
		// we will able to execute cloud builds with snapshot without having any local snapshot or Docker setup.
		// TODO: Remove this flag when we remove the native part from the plugin.
		envData.skipSnapshotTools = prepareData.nativePrepare && prepareData.nativePrepare.skipNativePrepare;

		if (prepareData.env && (prepareData.env.sourceMap === false || prepareData.env.sourceMap === 'false')) {
			delete envData.sourceMap;
		} else if (!prepareData.release) {
			envData.sourceMap = true;
		}

		return envData;
	}

	private async buildEnvCommandLineParams(envData: any, platformData: IPlatformData, projectData: IProjectData, prepareData: IPrepareData) {
		const envFlagNames = Object.keys(envData);
		const canSnapshot = prepareData.release && this.$mobileHelper.isAndroidPlatform(platformData.normalizedPlatformName);
		if (envData && envData.snapshot) {
			if (!canSnapshot) {
				this.$logger.warn("Stripping the snapshot flag. " +
					"Bear in mind that snapshot is only available in Android release builds.");
				envFlagNames.splice(envFlagNames.indexOf("snapshot"), 1);
			} else if (this.$hostInfo.isWindows) {
				const minWebpackPluginWithWinSnapshotsVersion = "1.3.0";
				const installedWebpackPluginVersion = await this.$packageInstallationManager.getInstalledDependencyVersion(WEBPACK_PLUGIN_NAME, projectData.projectDir);
				const hasWebpackPluginWithWinSnapshotsSupport = !!installedWebpackPluginVersion ? semver.gte(semver.coerce(installedWebpackPluginVersion), minWebpackPluginWithWinSnapshotsVersion) : true;
				if (!hasWebpackPluginWithWinSnapshotsSupport) {
					this.$errors.fail(`In order to generate Snapshots on Windows, please upgrade your Webpack plugin version (npm i nativescript-dev-webpack@latest).`);
				}
			}
		}

		const args: any[] = [];
		envFlagNames.map(item => {
			let envValue = envData[item];
			if (typeof envValue === "undefined") {
				return;
			}
			if (typeof envValue === "boolean") {
				if (envValue) {
					args.push(`--env.${item}`);
				}
			} else {
				if (!Array.isArray(envValue)) {
					envValue = [envValue];
				}

				envValue.map((value: any) => args.push(`--env.${item}=${value}`));
			}
		});

		return args;
	}

	public getUpdatedEmittedFiles(allEmittedFiles: string[], chunkFiles: string[], nextHash: string, platform: string) {
		const currentHash = this.getCurrentHotUpdateHash(allEmittedFiles);

		// This logic is needed as there are already cases when webpack doesn't emit any files physically.
		// We've set noEmitOnErrors in webpack.config.js based on noEmitOnError from tsconfig.json,
		// so webpack doesn't emit any files when noEmitOnErrors: true is set in webpack.config.js and
		// there is a compilation error in the source code. On the other side, hmr generates new hot-update files
		// on every change and the hash of the next hmr update is written inside hot-update.json file.
		// Although webpack doesn't emit any files, hmr hash is still generated. The hash is generated per compilation no matter
		// if files will be emitted or not. This way, the first successful compilation after fixing the compilation error generates
		// a hash that is not the same as the one expected in the latest emitted hot-update.json file.
		// As a result, the hmr chain is broken and the changes are not applied.
		const isHashValid = nextHash ? this.expectedHashes[platform] === currentHash : true;
		this.expectedHashes[platform] = nextHash;

		const emittedHotUpdatesAndAssets = isHashValid ? _.difference(allEmittedFiles, chunkFiles) : allEmittedFiles;

		return { emittedFiles: emittedHotUpdatesAndAssets, fallbackFiles: chunkFiles, hash: currentHash };
	}

	private getCurrentHotUpdateHash(emittedFiles: string[]) {
		let hotHash;
		const hotUpdateScripts = emittedFiles.filter(x => x.endsWith('.hot-update.js'));
		if (hotUpdateScripts && hotUpdateScripts.length) {
			// the hash is the same for each hot update in the current compilation
			const hotUpdateName = hotUpdateScripts[0];
			const matcher = /^(.+)\.(.+)\.hot-update/gm;
			const matches = matcher.exec(hotUpdateName);
			hotHash = matches[2];
		}

		return hotHash || "";
	}

	private async stopWebpackForPlatform(platform: string) {
		this.$logger.trace(`Stopping webpack watch for platform ${platform}.`);
		const webpackProcess = this.webpackProcesses[platform];
		await this.$cleanupService.removeKillProcess(webpackProcess.pid.toString());
		if (webpackProcess) {
			webpackProcess.kill("SIGINT");
			delete this.webpackProcesses[platform];
		}
	}
}
$injector.register("webpackCompilerService", WebpackCompilerService);
