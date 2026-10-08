// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice LOCAL TEST FIXTURE ONLY. Native Anvil units have no economic value.
/// @dev An issuer locks a synthetic payment for one fixed beneficiary. This is
/// deliberately not a production payment, wallet-recovery, or escrow protocol.
contract PaymentRight {
    error OnlyIssuer();
    error InvalidBeneficiary();
    error EmptyPayment();
    error ExistingRight();
    error UnknownRight();
    error WrongBeneficiary();
    error AlreadyClaimed();
    error DeliveryFailed();

    struct Right {
        address beneficiary;
        uint256 amount;
        bool claimed;
    }

    address public immutable issuer;
    uint256 public nextId = 1;
    mapping(uint256 => Right) private rights;
    mapping(address => uint256) public rightForOwner;

    event RightIssued(uint256 indexed id, address indexed beneficiary, uint256 amount);
    event RightClaimed(uint256 indexed id, address indexed beneficiary, uint256 amount);

    constructor() {
        issuer = msg.sender;
    }

    function issue(address beneficiary) external payable returns (uint256 id) {
        if (msg.sender != issuer) revert OnlyIssuer();
        if (beneficiary == address(0)) revert InvalidBeneficiary();
        if (msg.value == 0) revert EmptyPayment();
        if (rightForOwner[beneficiary] != 0) revert ExistingRight();
        id = nextId++;
        rights[id] = Right(beneficiary, msg.value, false);
        rightForOwner[beneficiary] = id;
        emit RightIssued(id, beneficiary, msg.value);
    }

    function getRight(uint256 id) external view returns (Right memory right) {
        right = rights[id];
        if (right.beneficiary == address(0)) revert UnknownRight();
    }

    function claim(uint256 id) external {
        Right storage right = rights[id];
        if (right.beneficiary == address(0)) revert UnknownRight();
        if (msg.sender != right.beneficiary) revert WrongBeneficiary();
        if (right.claimed) revert AlreadyClaimed();
        right.claimed = true;
        (bool sent,) = payable(right.beneficiary).call{value: right.amount}("");
        if (!sent) revert DeliveryFailed();
        emit RightClaimed(id, right.beneficiary, right.amount);
    }
}
