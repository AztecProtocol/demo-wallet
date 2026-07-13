import type { TxSimulationResult, PrivateCallExecutionResult } from "@aztec/stdlib/tx";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import {
  getFunctionArtifact,
  type AbiDecoded,
  FunctionSelector,
  getAllFunctionAbis,
  type FunctionAbi,
} from "@aztec/stdlib/abi";
import { decodeFromAbi } from "@aztec/aztec.js/abi";
import { formatAbiValue } from "./utils";
import type { DecodingCache } from "./decoding-cache";
import { Fr } from "@aztec/foundation/curves/bn254";
import { PRIVATE_CONTEXT_INPUTS_LENGTH } from "@aztec/constants";

export type ExecutionEvent = PrivateCallEvent | PublicCallEvent;

export interface PrivateCallEvent {
  type: "private-call";
  depth: number;
  counter: { start: number; end: number };
  contract: { name: string; address: string };
  function: string;
  caller: { name: string; address: string };
  isStaticCall: boolean;
  args: Array<{ name: string; value: string }>;
  returnValues: Array<{ name: string; value: string }>;
  nestedEvents: ExecutionEvent[];
}

/**
 * Represents a public call - either enqueued during private execution or
 * executed directly (e.g., optimized public static calls).
 * Return values are populated when the call has been executed.
 */
export interface PublicCallEvent {
  type: "public-call";
  depth: number;
  counter: number;
  contract: { name: string; address: string };
  function: string;
  caller: { name: string; address: string };
  isStaticCall: boolean;
  args: Array<{ name: string; value: string }>;
  /** Return values - populated when the call has been executed */
  returnValues?: Array<{ name: string; value: string }>;
}

export interface DecodedExecutionTrace {
  privateExecution: PrivateCallEvent;
  /** Public calls in execution order. Return values populated if executed. */
  publicCalls: PublicCallEvent[];
}

export class TxCallStackDecoder {
  private calldataMap: Map<string, any[]> = new Map();

  constructor(
    private cache: DecodingCache,
    private log?: any,
  ) {}

  private async formatAndResolveValue(value: AbiDecoded): Promise<string> {
    // Handle arrays recursively
    if (Array.isArray(value)) {
      const formattedElements = await Promise.all(
        value.map(async (v) => await this.formatAndResolveValue(v)),
      );
      return `[${formattedElements.join(", ")}]`;
    }

    let formatted = formatAbiValue(value);

    // Try to resolve addresses - handle both string addresses and object addresses
    let valueStr: string | null = null;

    if (typeof value === "string") {
      valueStr = value;
    } else if (value && typeof value === "object" && "toString" in value) {
      valueStr = value.toString();
    }

    if (valueStr && valueStr.startsWith("0x") && valueStr.length === 66) {
      try {
        const addr = AztecAddress.fromStringUnsafe(valueStr);
        const alias = await this.cache.getAddressAlias(addr);
        formatted = `${alias} (${formatted.slice(0, 10)}...${formatted.slice(-8)})`;
      } catch {
        // Not a valid address, use original formatted value
      }
    }

    return formatted;
  }

  /**
   * Extract and decode function arguments from the partial witness.
   * The witness layout is: [arguments (0 to parametersSize-1), context, returnData, ...]
   */
  private extractArgsFromWitness(
    partialWitness: Map<number, string>,
    functionAbi: FunctionAbi,
  ): Fr[] {
    // Calculate the total size of parameters
    let parametersSize = 0;
    for (const param of functionAbi.parameters) {
      parametersSize += this.getTypeSize(param.type);
    }

    // Extract the argument fields from witness
    const argsFields: Fr[] = [];
    for (
      let i = PRIVATE_CONTEXT_INPUTS_LENGTH;
      i < parametersSize + PRIVATE_CONTEXT_INPUTS_LENGTH;
      i++
    ) {
      const witnessValue = partialWitness.get(i);
      if (witnessValue !== undefined) {
        argsFields.push(Fr.fromString(witnessValue));
      }
    }

    return argsFields;
  }

  /**
   * Calculate the field size of an ABI type (how many field elements it occupies).
   * This mirrors ArgumentEncoder.typeSize from aztec-packages.
   */
  private getTypeSize(abiType: any): number {
    switch (abiType.kind) {
      case "field":
      case "boolean":
      case "integer":
        return 1;
      case "string":
        return abiType.length;
      case "array":
        return abiType.length * this.getTypeSize(abiType.type);
      case "struct":
        return abiType.fields.reduce((acc: number, field: any) => {
          return acc + this.getTypeSize(field.type);
        }, 0);
      default:
        throw new Error(`Unsupported type kind: ${abiType.kind}`);
    }
  }

  private async decodePrivateCall(
    call: PrivateCallExecutionResult,
    depth: number,
    parentPublicEnqueues: Array<{ counter: number; request: any }>,
  ): Promise<PrivateCallEvent> {
    const callContext = call.publicInputs.callContext;
    const startCounter = call.publicInputs.startSideEffectCounter.toNumber();
    const endCounter = call.publicInputs.endSideEffectCounter.toNumber();

    const contractName = await this.cache.getAddressAlias(callContext.contractAddress);
    const callerName = await this.cache.getAddressAlias(callContext.msgSender);

    let functionName = `0x${callContext.functionSelector.toString().slice(2, 10)}`;
    let args: Array<{ name: string; value: string }> = [];
    let returnValues: Array<{ name: string; value: string }> = [];

    try {
      const instance = await this.cache.getContractInstance(callContext.contractAddress);
      const artifact = await this.cache.getContractArtifact(instance.originalContractClassId);
      const functionAbi = await getFunctionArtifact(artifact, callContext.functionSelector);
      functionName = functionAbi.name;

      // Extract arguments from partialWitness
      if (functionAbi.parameters.length > 0 && call.partialWitness) {
        try {
          const argsValues = this.extractArgsFromWitness(call.partialWitness, functionAbi);

          // Reuse the generic argument decoding helper
          args = await this.decodeAndFormatArguments(functionAbi, argsValues);
        } catch {
          // Silently fail - args will remain empty
        }
      }

      // Decode return values - reuse the generic return value decoding helper
      if (functionAbi.returnTypes.length > 0) {
        returnValues = await this.decodeAndFormatReturnValues(functionAbi, call.returnValues);
      }
    } catch {
      // If we can't decode, use raw values with consistent naming
      const rvCount = call.returnValues.length;
      returnValues = await Promise.all(
        call.returnValues.map(async (rv, i) => ({
          name: rvCount === 1 ? "result" : `result_${i}`,
          value: rv.toString(),
        })),
      );
    }

    // Get public enqueues from this specific call's publicInputs
    const thisCallPublicEnqueues = call.publicInputs.publicCallRequests
      .getActiveItems()
      .map((countedReq) => ({
        counter: countedReq.counter,
        request: countedReq.inner,
      }));

    // Combine with parent's public enqueues for proper ordering
    const allPublicEnqueues = [...parentPublicEnqueues, ...thisCallPublicEnqueues].sort(
      (a, b) => a.counter - b.counter,
    );

    // Build nested events with interleaved public enqueues
    const nestedEvents: ExecutionEvent[] = [];

    // Track which public enqueues have been added
    const addedEnqueues = new Set<number>();

    // Process nested calls
    if (call.nestedExecutionResults && call.nestedExecutionResults.length > 0) {
      for (let i = 0; i < call.nestedExecutionResults.length; i++) {
        const nestedCall = call.nestedExecutionResults[i];
        const nestedStartCounter = nestedCall.publicInputs.startSideEffectCounter.toNumber();

        // Add public enqueues that happened before this nested call starts
        const enqueuedBefore = allPublicEnqueues.filter(
          (e) =>
            e.counter >= startCounter &&
            e.counter < nestedStartCounter &&
            !addedEnqueues.has(e.counter),
        );

        for (const enq of enqueuedBefore) {
          const event = await this.decodePublicCall(enq.request, depth + 1, enq.counter);
          nestedEvents.push(event);
          addedEnqueues.add(enq.counter);
        }

        // Recursively decode nested call
        const nestedEvent = await this.decodePrivateCall(nestedCall, depth + 1, allPublicEnqueues);
        nestedEvents.push(nestedEvent);
      }
    }

    // Add any remaining public enqueues after all nested calls
    const enqueuedAfter = allPublicEnqueues.filter(
      (e) => e.counter >= startCounter && e.counter < endCounter && !addedEnqueues.has(e.counter),
    );

    for (const enq of enqueuedAfter) {
      const event = await this.decodePublicCall(enq.request, depth + 1, enq.counter);
      nestedEvents.push(event);
      addedEnqueues.add(enq.counter);
    }

    return {
      type: "private-call",
      depth,
      counter: { start: startCounter, end: endCounter },
      contract: {
        name: contractName,
        address: callContext.contractAddress.toString(),
      },
      function: functionName,
      caller: {
        name: callerName,
        address: callContext.msgSender.toString(),
      },
      isStaticCall: callContext.isStaticCall,
      args,
      returnValues,
      nestedEvents,
    };
  }

  private async decodePublicCall(
    request: any,
    depth: number,
    counter: number,
  ): Promise<PublicCallEvent> {
    const contractName = await this.cache.getAddressAlias(request.contractAddress);
    const callerName = await this.cache.getAddressAlias(request.msgSender);

    // Get calldata using the calldataHash
    let functionName = "public_function";
    let args: Array<{ name: string; value: string }> = [];
    const calldataHashStr = request.calldataHash.toString();
    const calldata = this.calldataMap.get(calldataHashStr);

    if (calldata && calldata.length > 0) {
      // First element of calldata is the function selector
      const functionSelector = FunctionSelector.fromField(calldata[0]);

      // Try to resolve function name and decode arguments from contract ABI
      try {
        const instance = await this.cache.getContractInstance(request.contractAddress);
        const artifact = await this.cache.getContractArtifact(instance.originalContractClassId);
        const allAbis = await getAllFunctionAbis(artifact);
        const abisWithSelector = await Promise.all(
          allAbis.map(async (abi) => ({
            ...abi,
            selector: await FunctionSelector.fromNameAndParameters(abi.name, abi.parameters),
          })),
        );
        const functionAbi = abisWithSelector.find((abi) => abi.selector.equals(functionSelector));

        if (functionAbi) {
          functionName = functionAbi.name;

          // Decode arguments - calldata is [selector, ...args]
          if (functionAbi.parameters.length > 0 && calldata.length > 1) {
            const argsData = calldata.slice(1); // Skip the selector
            args = await this.decodeAndFormatArguments(functionAbi, argsData);
          }
        }
      } catch (error) {
        // If we can't resolve from ABI, use the selector hex
        this.log?.error("Failed to resolve function from ABI:", error);
        functionName = `0x${functionSelector.toString().slice(2, 10)}`;
      }
    }

    return {
      type: "public-call",
      depth,
      counter,
      contract: {
        name: contractName,
        address: request.contractAddress.toString(),
      },
      function: functionName,
      caller: {
        name: callerName,
        address: request.msgSender.toString(),
      },
      isStaticCall: request.isStaticCall,
      args,
    };
  }

  async decodeSimulationResult(
    simulationResult: TxSimulationResult,
  ): Promise<DecodedExecutionTrace> {
    // Build calldata map from publicFunctionCalldata
    this.calldataMap.clear();
    if (simulationResult.privateExecutionResult.publicFunctionCalldata) {
      for (const hashedCalldata of simulationResult.privateExecutionResult.publicFunctionCalldata) {
        this.calldataMap.set(hashedCalldata.hash.toString(), hashedCalldata.values);
      }
    }

    const entrypoint = simulationResult.privateExecutionResult.entrypoint;

    // Decode the private execution tree
    const privateExecution = await this.decodePrivateCall(entrypoint, 0, []);

    // Collect all public calls in execution order (by counter)
    const allPublicCalls: PublicCallEvent[] = [];

    const collectPublicCalls = (event: ExecutionEvent) => {
      if (event.type === "public-call") {
        allPublicCalls.push(event);
      } else if (event.type === "private-call") {
        event.nestedEvents.forEach(collectPublicCalls);
      }
    };

    collectPublicCalls(privateExecution);

    // Sort by counter to show execution order
    allPublicCalls.sort((a, b) => a.counter - b.counter);

    // Populate return values from publicOutput.publicReturnValues
    const publicReturnValues = simulationResult.publicOutput?.publicReturnValues ?? [];

    for (let i = 0; i < allPublicCalls.length && i < publicReturnValues.length; i++) {
      const returnValue = publicReturnValues[i];
      const publicCall = allPublicCalls[i];

      if (returnValue?.values && returnValue.values.length > 0) {
        // Try to decode return values using the function ABI
        publicCall.returnValues = await this.decodePublicCallReturnValues(
          AztecAddress.fromStringUnsafe(publicCall.contract.address),
          publicCall.function,
          returnValue.values,
        );
      }
    }

    return {
      privateExecution,
      publicCalls: allPublicCalls,
    };
  }

  /**
   * Decode return values for a public call using the function ABI.
   * Note: returnValues may be Fr instances or serialized values (after IPC).
   */
  private async decodePublicCallReturnValues(
    contractAddress: AztecAddress,
    functionName: string,
    returnValues: unknown[],
  ): Promise<Array<{ name: string; value: string }>> {
    // Ensure values are proper Fr instances (they may have been serialized)
    // Use Fr.fromPlainObject which handles various serialized formats
    const frValues = returnValues.map((v) => Fr.fromPlainObject(v));

    try {
      const instance = await this.cache.getContractInstance(contractAddress);
      const artifact = await this.cache.getContractArtifact(instance.originalContractClassId);

      // Use getAllFunctionAbis to get all functions including non-dispatch public functions
      const allAbis = getAllFunctionAbis(artifact);

      // Find the function by name
      const functionAbi = allAbis.find((f) => f.name === functionName);

      if (functionAbi) {
        return await this.decodeAndFormatReturnValues(functionAbi, frValues);
      }
    } catch (error) {
      this.log?.debug("Could not decode public call return values:", error);
    }

    // Fallback: return raw values with consistent naming
    return frValues.map((rv, i) => ({
      name: frValues.length === 1 ? "result" : `result_${i}`,
      value: rv.toString(),
    }));
  }

  /**
   * Generic helper to decode and format function arguments.
   * Reused by both transaction decoding and utility function decoding.
   *
   * @param functionAbi - The function ABI containing parameter definitions
   * @param args - Raw Fr[] arguments to decode
   * @returns Array of formatted arguments with names and display values
   */
  private async decodeAndFormatArguments(
    functionAbi: FunctionAbi,
    args: Fr[],
  ): Promise<Array<{ name: string; value: string }>> {
    if (!functionAbi.parameters || functionAbi.parameters.length === 0) {
      return [];
    }

    // Decode the Fr[] args using the function's parameter types
    const decoded = decodeFromAbi(
      functionAbi.parameters.map((p) => p.type),
      args,
    );

    // decodeFromAbi returns a single value if there's one param, or an array for multiple
    const decodedArgs = Array.isArray(decoded) ? decoded : [decoded];

    // Format each decoded argument with address resolution
    return await Promise.all(
      decodedArgs.map(async (value, i) => ({
        name: functionAbi.parameters[i]?.name || `arg_${i}`,
        value: await this.formatAndResolveValue(value),
      })),
    );
  }

  /**
   * Generic helper to decode and format function return values.
   * Reused by both transaction decoding and utility function decoding.
   *
   * @param functionAbi - The function ABI containing return type definitions
   * @param returnValues - Raw Fr[] return values to decode
   * @returns Array of formatted return values with names and display values
   */
  private async decodeAndFormatReturnValues(
    functionAbi: FunctionAbi,
    returnValues: Fr[],
  ): Promise<Array<{ name: string; value: string }>> {
    if (!functionAbi.returnTypes || functionAbi.returnTypes.length === 0) {
      return [];
    }

    // Decode the Fr[] return values using the function's return types
    const decoded = decodeFromAbi(functionAbi.returnTypes, returnValues);

    // decodeFromAbi returns a single value if there's one return type, or an array for multiple
    const decodedReturns = Array.isArray(decoded) ? decoded : [decoded];

    // Use "result" for single return value (like utilities), indexed names for multiple
    return await Promise.all(
      decodedReturns.map(async (value, i) => ({
        name: decodedReturns.length === 1 ? "result" : `result_${i}`,
        value: await this.formatAndResolveValue(value),
      })),
    );
  }

  /**
   * Format utility function arguments for display.
   * Takes raw Fr[] from FunctionCall.args, decodes using function's parameter types ABI,
   * then formats with address resolution.
   *
   * This method reuses the generic decoding helpers that are also used by transaction decoding.
   */
  async formatUtilityArguments(
    contractAddress: AztecAddress,
    functionName: string,
    args: Fr[],
  ): Promise<Array<{ name: string; value: string }>> {
    if (args.length === 0) {
      return [];
    }

    try {
      // Retrieve contract instance and artifact
      const instance = await this.cache.getContractInstance(contractAddress);

      const artifact = await this.cache.getContractArtifact(instance.originalContractClassId);

      // Find the function in the artifact
      const functionAbi = artifact.functions.find((f) => f.name === functionName);
      if (!functionAbi) {
        throw new Error(`Function ${functionName} not found in artifact`);
      }

      // Reuse the generic argument decoding helper (same logic as transaction decoding)
      return await this.decodeAndFormatArguments(functionAbi, args);
    } catch {
      // If formatting fails, return raw representation of Fr[] values
      return args.map((arg, i) => ({
        name: `arg_${i}`,
        value: arg.toString(),
      }));
    }
  }

  /**
   * Format utility function result for display with address resolution.
   * Takes raw Fr[] from UtilitySimulationResult, decodes using function's return type ABI,
   * then formats with address aliases.
   *
   * This method reuses the generic decoding helpers that are also used by transaction decoding.
   */
  async formatUtilityResult(
    contractAddress: AztecAddress,
    functionName: string,
    result: Fr[],
  ): Promise<string> {
    try {
      // Retrieve contract instance and artifact
      const instance = await this.cache.getContractInstance(contractAddress);

      const artifact = await this.cache.getContractArtifact(instance.originalContractClassId);

      // Find the function in the artifact
      const functionAbi = artifact.functions.find((f) => f.name === functionName);
      if (!functionAbi) {
        throw new Error(`Function ${functionName} not found in artifact`);
      }

      // If the function has no return type, return empty string
      if (!functionAbi.returnTypes || functionAbi.returnTypes.length === 0) {
        return "void";
      }

      // Reuse the generic return value decoding helper (same logic as transaction decoding)
      const formattedReturns = await this.decodeAndFormatReturnValues(functionAbi, result);

      // For utility functions, we typically have a single return value
      // If there are multiple, join them with commas
      if (formattedReturns.length === 0) {
        return "void";
      } else if (formattedReturns.length === 1) {
        return formattedReturns[0].value;
      } else {
        return `[${formattedReturns.map((r) => r.value).join(", ")}]`;
      }
    } catch {
      // If formatting fails, return raw representation of Fr[] values
      return `[${result.map((fr) => fr.toString()).join(", ")}]`;
    }
  }
}
