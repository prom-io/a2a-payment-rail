// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract EscrowHub {
    address public owner;

    /// @notice May stop the hub in an emergency, and nothing else. Lifting the
    /// stop is the owner's call: a compromised guardian key can at worst
    /// freeze payouts, never resume them or move funds.
    address public guardian;
    /// @notice While true no escrow is opened and nothing is paid to a payee.
    /// Payers can still close their escrows and get the rest back.
    bool public paused;

    modifier onlyOwner() {
        require(msg.sender == owner, "EscrowHub: not owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "EscrowHub: paused");
        _;
    }

    struct EscrowSession {
        address agentA;
        address agentB;
        uint256 deposit;
        uint256 budgetLimit;
        uint256 spent;
        bool verificationRequired;
        uint256 ttl;
        uint256 createdAt;
        bool active;
        bool disputed;
    }

    mapping(bytes32 => EscrowSession) public escrows;

    uint256 public feePercent = 50; // 0.5% in basis points (/10000)

    event EscrowOpened(
        bytes32 indexed escrowId,
        address indexed agentA,
        address agentB,
        uint256 deposit,
        uint256 budgetLimit,
        uint256 ttl
    );
    event BatchSettled(
        bytes32 indexed escrowId,
        bytes32 receiptsHash,
        uint256 totalAmount
    );
    event StreamClaimed(
        bytes32 indexed escrowId,
        address indexed agentB,
        uint256 usageDelta,
        uint256 newSpent
    );
    event EscrowClosed(bytes32 indexed escrowId, uint256 refund);
    event EscrowDisputed(bytes32 indexed escrowId);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event GuardianChanged(address indexed previousGuardian, address indexed newGuardian);

    constructor() {
        owner = msg.sender;
        guardian = msg.sender;
        emit GuardianChanged(address(0), msg.sender);
    }

    /// @notice Hands the guardian role to another address, typically a
    /// monitoring key or a multisig that can act faster than the owner.
    /// The zero address disables the role; the owner can still pause.
    function setGuardian(address newGuardian) external onlyOwner {
        emit GuardianChanged(guardian, newGuardian);
        guardian = newGuardian;
    }

    /// @notice Emergency stop of openEscrow, settleBatch and claimStream.
    function pause() external {
        require(msg.sender == guardian || msg.sender == owner, "EscrowHub: not guardian");
        require(!paused, "EscrowHub: already paused");
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        require(paused, "EscrowHub: not paused");
        paused = false;
        emit Unpaused(msg.sender);
    }

    function openEscrow(
        bytes32 escrowId,
        address agentB,
        uint256 budgetLimit,
        bool verificationRequired,
        uint256 ttl
    ) external payable whenNotPaused {
        require(escrows[escrowId].createdAt == 0, "EscrowHub: already exists");
        require(msg.value > 0, "EscrowHub: deposit required");
        require(agentB != address(0), "EscrowHub: invalid agentB");

        escrows[escrowId] = EscrowSession({
            agentA: msg.sender,
            agentB: agentB,
            deposit: msg.value,
            budgetLimit: budgetLimit,
            spent: 0,
            verificationRequired: verificationRequired,
            ttl: ttl,
            createdAt: block.timestamp,
            active: true,
            disputed: false
        });

        emit EscrowOpened(
            escrowId,
            msg.sender,
            agentB,
            msg.value,
            budgetLimit,
            ttl
        );
    }

    function settleBatch(
        bytes32 escrowId,
        bytes32 receiptsHash,
        uint256 totalAmount
    ) external whenNotPaused {
        EscrowSession storage session = escrows[escrowId];
        require(session.active, "EscrowHub: not active");
        require(!session.disputed, "EscrowHub: disputed");
        require(
            session.spent + totalAmount <= session.budgetLimit,
            "EscrowHub: exceeds budget"
        );
        require(
            session.spent + totalAmount <= session.deposit,
            "EscrowHub: exceeds deposit"
        );

        uint256 fee = (totalAmount * feePercent) / 10000;
        uint256 payout = totalAmount - fee;

        session.spent += totalAmount;

        (bool sent, ) = session.agentB.call{value: payout}("");
        require(sent, "EscrowHub: transfer failed");

        emit BatchSettled(escrowId, receiptsHash, totalAmount);
    }

    function claimStream(bytes32 escrowId, uint256 usageDelta) external whenNotPaused {
        EscrowSession storage session = escrows[escrowId];
        require(session.active, "EscrowHub: not active");
        require(!session.disputed, "EscrowHub: disputed");
        require(
            msg.sender == session.agentB,
            "EscrowHub: only agentB"
        );
        require(
            block.timestamp <= session.createdAt + session.ttl,
            "EscrowHub: TTL expired"
        );
        require(
            session.spent + usageDelta <= session.budgetLimit,
            "EscrowHub: exceeds budget"
        );
        require(
            session.spent + usageDelta <= session.deposit,
            "EscrowHub: exceeds deposit"
        );

        uint256 fee = (usageDelta * feePercent) / 10000;
        uint256 payout = usageDelta - fee;

        session.spent += usageDelta;

        (bool sent, ) = session.agentB.call{value: payout}("");
        require(sent, "EscrowHub: transfer failed");

        emit StreamClaimed(escrowId, msg.sender, usageDelta, session.spent);
    }

    function closeEscrow(bytes32 escrowId) external {
        EscrowSession storage session = escrows[escrowId];
        require(session.active, "EscrowHub: not active");
        require(
            msg.sender == session.agentA,
            "EscrowHub: only agentA"
        );

        session.active = false;
        uint256 refund = session.deposit - session.spent;

        if (refund > 0) {
            (bool sent, ) = session.agentA.call{value: refund}("");
            require(sent, "EscrowHub: refund failed");
        }

        emit EscrowClosed(escrowId, refund);
    }

    function emergencyClose(bytes32 escrowId) external onlyOwner {
        EscrowSession storage session = escrows[escrowId];
        require(session.active, "EscrowHub: not active");

        session.active = false;
        uint256 refund = session.deposit - session.spent;

        if (refund > 0) {
            (bool sent, ) = session.agentA.call{value: refund}("");
            require(sent, "EscrowHub: refund failed");
        }

        emit EscrowClosed(escrowId, refund);
    }

    function freezeOnDispute(bytes32 escrowId) external {
        EscrowSession storage session = escrows[escrowId];
        require(session.active, "EscrowHub: not active");
        session.disputed = true;

        emit EscrowDisputed(escrowId);
    }

    receive() external payable {}
}
