// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/VerdictIntegration.sol";

contract MockVerdictRegistry is IVerdictRegistry {
    mapping(bytes32 => uint8) public outcomes;
    mapping(bytes32 => uint256) public amounts;

    function setVerdict(
        bytes32 sessionId,
        uint8 outcome,
        uint256 amount
    ) external {
        outcomes[sessionId] = outcome;
        amounts[sessionId] = amount;
    }

    function getVerdict(
        bytes32 sessionId
    ) external view override returns (uint8, uint256) {
        return (outcomes[sessionId], amounts[sessionId]);
    }
}

contract ConcreteVerdictIntegration is VerdictIntegration {
    bool public frozen;
    bytes32 public frozenEscrowId;

    constructor(
        address _verdictRegistry
    ) VerdictIntegration(_verdictRegistry) {}

    function _freezeOnDispute(bytes32 escrowId) internal override {
        frozen = true;
        frozenEscrowId = escrowId;
    }
}

contract VerdictIntegrationTest is Test {
    MockVerdictRegistry public registry;
    ConcreteVerdictIntegration public integration;

    function setUp() public {
        registry = new MockVerdictRegistry();
        integration = new ConcreteVerdictIntegration(address(registry));
    }

    function test_checkVerdict_accept() public {
        bytes32 sessionId = keccak256("session-1");
        registry.setVerdict(sessionId, 0, 1 ether);

        (VerdictIntegration.Outcome outcome, uint256 amount) = integration
            .checkVerdict(sessionId);

        assertEq(uint8(outcome), uint8(VerdictIntegration.Outcome.Accept));
        assertEq(amount, 1 ether);
    }

    function test_checkVerdict_partial() public {
        bytes32 sessionId = keccak256("session-2");
        registry.setVerdict(sessionId, 1, 0.5 ether);

        (VerdictIntegration.Outcome outcome, uint256 amount) = integration
            .checkVerdict(sessionId);

        assertEq(uint8(outcome), uint8(VerdictIntegration.Outcome.Partial));
        assertEq(amount, 0.5 ether);
    }

    function test_checkVerdict_reject() public {
        bytes32 sessionId = keccak256("session-3");
        registry.setVerdict(sessionId, 2, 0);

        (VerdictIntegration.Outcome outcome, uint256 amount) = integration
            .checkVerdict(sessionId);

        assertEq(uint8(outcome), uint8(VerdictIntegration.Outcome.Reject));
        assertEq(amount, 0);
    }

    function test_freezeOnDispute() public {
        bytes32 escrowId = keccak256("escrow-1");
        integration.freezeOnDispute(escrowId);

        assertTrue(integration.frozen());
        assertEq(integration.frozenEscrowId(), escrowId);
    }
}
