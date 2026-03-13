// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVerdictRegistry {
    function getVerdict(
        bytes32 sessionId
    ) external view returns (uint8 outcome, uint256 payableAmount);
}

abstract contract VerdictIntegration {
    address public verdictRegistry;

    enum Outcome {
        Accept,
        Partial,
        Reject
    }

    constructor(address _verdictRegistry) {
        verdictRegistry = _verdictRegistry;
    }

    function checkVerdict(
        bytes32 sessionId
    ) external view returns (Outcome, uint256 payableAmount) {
        (uint8 rawOutcome, uint256 amount) = IVerdictRegistry(verdictRegistry)
            .getVerdict(sessionId);
        require(rawOutcome <= uint8(Outcome.Reject), "VerdictIntegration: invalid outcome");
        return (Outcome(rawOutcome), amount);
    }

    function _freezeOnDispute(bytes32 escrowId) internal virtual;

    function freezeOnDispute(bytes32 escrowId) external {
        _freezeOnDispute(escrowId);
    }
}
