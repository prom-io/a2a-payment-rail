// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/EscrowHub.sol";

contract EscrowHubPauseTest is Test {
    EscrowHub public hub;
    address public owner;
    address public guardian = address(0x6A);
    address public agentA = address(0x1);
    address public agentB = address(0x2);
    address public stranger = address(0xBAD);
    bytes32 public escrowId = keccak256("pause-escrow");

    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event GuardianChanged(address indexed previousGuardian, address indexed newGuardian);

    function setUp() public {
        owner = address(this);
        hub = new EscrowHub();
        hub.setGuardian(guardian);

        vm.deal(agentA, 10 ether);
        vm.prank(agentA);
        hub.openEscrow{value: 1 ether}(escrowId, agentB, 1 ether, false, 3600);
    }

    function _activeAndSpent() internal view returns (bool active, uint256 spent) {
        (, , , , spent, , , , active, ) = hub.escrows(escrowId);
    }

    function test_deployerStartsAsGuardianAndUnpaused() public {
        EscrowHub fresh = new EscrowHub();
        assertEq(fresh.guardian(), address(this));
        assertFalse(fresh.paused());
    }

    function test_guardianCanPause() public {
        vm.expectEmit(true, false, false, false);
        emit Paused(guardian);
        vm.prank(guardian);
        hub.pause();

        assertTrue(hub.paused());
    }

    function test_ownerCanPauseToo() public {
        hub.pause();
        assertTrue(hub.paused());
    }

    function test_strangerCannotPause() public {
        vm.prank(stranger);
        vm.expectRevert("EscrowHub: not guardian");
        hub.pause();
    }

    function test_pauseTwiceReverts() public {
        vm.prank(guardian);
        hub.pause();
        vm.prank(guardian);
        vm.expectRevert("EscrowHub: already paused");
        hub.pause();
    }

    function test_onlyOwnerUnpauses() public {
        vm.prank(guardian);
        hub.pause();

        vm.prank(guardian);
        vm.expectRevert("EscrowHub: not owner");
        hub.unpause();

        vm.expectEmit(true, false, false, false);
        emit Unpaused(owner);
        hub.unpause();
        assertFalse(hub.paused());
    }

    function test_unpauseWhenNotPausedReverts() public {
        vm.expectRevert("EscrowHub: not paused");
        hub.unpause();
    }

    function test_pauseBlocksPayoutsAndNewEscrows() public {
        vm.prank(guardian);
        hub.pause();

        vm.expectRevert("EscrowHub: paused");
        hub.settleBatch(escrowId, keccak256("receipts"), 0.1 ether);

        vm.prank(agentB);
        vm.expectRevert("EscrowHub: paused");
        hub.claimStream(escrowId, 0.05 ether);

        vm.prank(agentA);
        vm.expectRevert("EscrowHub: paused");
        hub.openEscrow{value: 1 ether}(keccak256("another"), agentB, 1 ether, false, 3600);

        (, uint256 spent) = _activeAndSpent();
        assertEq(spent, 0);
        assertEq(address(hub).balance, 1 ether);
    }

    function test_payerCanStillCloseWhilePaused() public {
        vm.prank(guardian);
        hub.pause();

        uint256 before = agentA.balance;
        vm.prank(agentA);
        hub.closeEscrow(escrowId);

        assertEq(agentA.balance - before, 1 ether);
        (bool active, ) = _activeAndSpent();
        assertFalse(active);
    }

    function test_ownerCanEmergencyCloseWhilePaused() public {
        hub.pause();
        hub.emergencyClose(escrowId);
        (bool active, ) = _activeAndSpent();
        assertFalse(active);
    }

    function test_payoutsResumeAfterUnpause() public {
        vm.prank(guardian);
        hub.pause();
        hub.unpause();

        hub.settleBatch(escrowId, keccak256("receipts"), 0.1 ether);
        (, uint256 spent) = _activeAndSpent();
        assertEq(spent, 0.1 ether);
    }

    function test_onlyOwnerSetsGuardian() public {
        vm.prank(guardian);
        vm.expectRevert("EscrowHub: not owner");
        hub.setGuardian(stranger);

        vm.expectEmit(true, true, false, false);
        emit GuardianChanged(guardian, stranger);
        hub.setGuardian(stranger);
        assertEq(hub.guardian(), stranger);

        // the old guardian has lost the role
        vm.prank(guardian);
        vm.expectRevert("EscrowHub: not guardian");
        hub.pause();
    }

    function test_zeroGuardianDisablesTheRoleButNotTheOwner() public {
        hub.setGuardian(address(0));

        vm.prank(guardian);
        vm.expectRevert("EscrowHub: not guardian");
        hub.pause();

        hub.pause();
        assertTrue(hub.paused());
    }

    function testFuzz_onlyGuardianOrOwnerCanPause(address caller) public {
        vm.assume(caller != guardian && caller != owner);
        vm.prank(caller);
        vm.expectRevert("EscrowHub: not guardian");
        hub.pause();
        assertFalse(hub.paused());
    }
}
