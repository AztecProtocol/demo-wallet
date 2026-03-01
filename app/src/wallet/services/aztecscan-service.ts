import type { ContractArtifact } from "@aztec/stdlib/abi";

/**
 * Response shape from the AztecScan API for a contract class version.
 * Only the fields we need are typed here.
 */
interface ContractClassVersionResponse {
  contractClassId: string;
  version: number;
  artifactHash: string;
  artifactJson: string | null;
  artifactContractName: string | null;
}

/**
 * Lightweight service for fetching contract artifacts from the AztecScan API.
 * Uses native fetch() with no @aztec/* runtime dependencies beyond types.
 */
export class AztecScanService {
  private baseUrl: string;
  private apiKey: string;
  private timeout: number;
  private log: { info: (...args: any[]) => void; error: (...args: any[]) => void; debug: (...args: any[]) => void };

  constructor(
    apiUrl: string,
    apiKey: string,
    logger?: { info: (...args: any[]) => void; error: (...args: any[]) => void; debug: (...args: any[]) => void },
    timeout = 30_000,
  ) {
    this.baseUrl = apiUrl;
    this.apiKey = apiKey;
    this.timeout = timeout;
    this.log = logger ?? {
      info: console.info.bind(console),
      error: console.error.bind(console),
      debug: console.debug.bind(console),
    };
  }

  /**
   * Fetch a contract class with its artifact from the AztecScan API.
   *
   * @param contractClassId - The 0x-prefixed hex class ID
   * @param version - The contract class version (typically 1)
   * @returns The parsed ContractArtifact if available, or null
   */
  async fetchArtifact(
    contractClassId: string,
    version: number = 1,
  ): Promise<ContractArtifact | null> {
    const url = `${this.baseUrl}/v1/${this.apiKey}/l2/contract-classes/${contractClassId}/versions/${version}?includeArtifactJson=true`;

    this.log.info(
      `[AztecScanService] Fetching artifact for class ${contractClassId} v${version}`,
    );

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 404) {
          this.log.debug(
            `[AztecScanService] Contract class ${contractClassId} v${version} not found on AztecScan`,
          );
          return null;
        }
        this.log.error(
          `[AztecScanService] API returned ${response.status}: ${response.statusText}`,
        );
        return null;
      }

      const data: ContractClassVersionResponse = await response.json();

      if (!data.artifactJson) {
        this.log.debug(
          `[AztecScanService] Contract class ${contractClassId} v${version} found but artifact not verified`,
        );
        return null;
      }

      // artifactJson is a stringified JSON of the full NoirCompiledContract / ContractArtifact
      const artifact: ContractArtifact = JSON.parse(data.artifactJson);

      this.log.info(
        `[AztecScanService] Successfully fetched artifact "${artifact.name}" for class ${contractClassId}`,
      );

      return artifact;
    } catch (error: any) {
      if (error.name === "AbortError") {
        this.log.error(
          `[AztecScanService] Request timed out after ${this.timeout}ms`,
        );
      } else {
        this.log.error(
          `[AztecScanService] Failed to fetch artifact: ${error.message}`,
        );
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Check if the service is available (non-null config).
   */
  get isAvailable(): boolean {
    return true;
  }
}
