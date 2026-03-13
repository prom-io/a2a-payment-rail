// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/EscrowHub.sol";

contract EscrowHubTest is Test {
    EscrowHub public hub;
    address public agentA;
    address public agentB;
    bytes32 public escrowId;

    function setUp() public {
        hub = new EscrowHub();
        agentA = address(0x1);
        agentB = address(0x2);
        escrowId = keccak256("test-escrow-1");

        vm.deal(agentA, 10 ether);
        vm.deal(agentB, 1 ether);
    }

    function test_openEscrow() public {
        vm.prank(agentA);
        hub.openEscrow{value: 1 ether}(
            escrowId,
            agentB,
            1 ether,
            false,
            3600
        );

        (
            address a,
            address b,
            uint256 deposit,
            uint256 budgetLimit,
            uint256 spent,
            bool verificationRequired,
            uint256 ttl,
            uint256 createdAt,
            bool active,
            bool disputed
        ) = hub.escrows(escrowId);

        assertEq(a, agentA);
        assertEq(b, agentB);
        assertEq(deposit, 1 ether);
        assertEq(budgetLimit, 1 ether);
        assertEq(spent, 0);
        assertFalse(verificationRequired);
        assertEq(ttl, 3600);
        assertGt(createdAt, 0);
        assertTrue(active);
        assertFalse(disputed);
    }

    function test_settleBatch() public {
        vm.prank(agentA);
        hub.openEscrow{value: 1 ether}(
            escrowId,
            agentB,
            1 ether,
            false,
            3600
        );

        bytes32 receiptsHash = keccak256("receipts");
        uint256 amount = 0.1 ether;

        uint256 balBefore = agentB.balance;
        hub.settleBatch(escrowId, receiptsHash, amount);
        uint256 balAfter = agentB.balance;

        uint256 fee = (amount * 50) / 10000;
        assertEq(balAfter - balBefore, amount - fee);
    }

    function test_claimStream() public {
        vm.prank(agentA);
        hub.openEscrow{value: 1 ether}(
            escrowId,
            agentB,
            1 ether,
            false,
            3600
        );

        uint256 delta = 0.05 ether;
        uint256 balBefore = agentB.balance;

        vm.prank(agentB);
        hub.claimStream(escrowId, delta);

        uint256 balAfter = agentB.balance;
        uint256 fee = (delta * 50) / 10000;
        assertEq(balAfter - balBefore, delta - fee);
    }

    function test_claimStream_revert_notAgentB() public {
        vm.prank(agentA);
        hub.openEscrow{value: 1 ether}(
            escrowId,
            agentB,
            1 ether,
            false,
            3600
        );

        vm.prank(agentA);
        vm.expectRevert("EscrowHub: only agentB");
        hub.claimStream(escrowId, 0.05 ether);
    }

    function test_closeEscrow() public {
        vm.prank(agentA);
        hub.openEscrow{value: 1 ether}(
            escrowId,
            agentB,
            1 ether,
            false,
            3600
        );

        uint256 balBefore = agentA.balance;

        vm.prank(agentA);
        hub.closeEscrow(escrowId);

        uint256 balAfter = agentA.balance;
        assertEq(balAfter - balBefore, 1 ether);

        (, , , , , , , , bool active, ) = hub.escrows(escrowId);
        assertFalse(active);
    }

    function test_freezeOnDispute() public {
        vm.prank(agentA);
        hub.openEscrow{value: 1 ether}(
            escrowId,
            agentB,
            1 ether,
            false,
            3600
        );

        hub.freezeOnDispute(escrowId);

        (, , , , , , , , , bool disputed) = hub.escrows(escrowId);
        assertTrue(disputed);

        vm.prank(agentB);
        vm.expectRevert("EscrowHub: disputed");
        hub.claimStream(escrowId, 0.05 ether);
    }
}
