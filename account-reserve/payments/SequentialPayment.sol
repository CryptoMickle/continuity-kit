// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Experimental funded payment obligations; test units only.
/// @dev One outstanding obligation per beneficiary. Claiming settles that
/// obligation; it does not establish that any off-chain work was completed.
contract SequentialPayment {
    error OnlyIssuer();
    error InvalidBeneficiary();
    error EmptyPayment();
    error OutstandingPayment();
    error UnknownRight();
    error WrongBeneficiary();
    error AlreadyClaimed();
    error DeliveryFailed();
    error ReentrantCall();

    struct Right {
        address beneficiary;
        uint256 amount;
        bool claimed;
    }

    address public immutable issuer;
    uint256 public nextId = 1;
    mapping(uint256 => Right) private rights;
    mapping(address => uint256) public rightForOwner;
    bool private entered;

    event RightIssued(uint256 indexed id, address indexed beneficiary, uint256 amount);
    event RightClaimed(uint256 indexed id, address indexed beneficiary, uint256 amount);

    constructor() { issuer = msg.sender; }

    modifier nonReentrant() {
        if (entered) revert ReentrantCall();
        entered = true;
        _;
        entered = false;
    }

    function issue(address beneficiary) external payable nonReentrant returns (uint256 id) {
        if (msg.sender != issuer) revert OnlyIssuer();
        if (beneficiary == address(0)) revert InvalidBeneficiary();
        if (msg.value == 0) revert EmptyPayment();
        uint256 previous = rightForOwner[beneficiary];
        if (previous != 0 && !rights[previous].claimed) revert OutstandingPayment();
        id = nextId++;
        rights[id] = Right(beneficiary, msg.value, false);
        rightForOwner[beneficiary] = id;
        emit RightIssued(id, beneficiary, msg.value);
    }

    function getRight(uint256 id) external view returns (Right memory right) {
        right = rights[id];
        if (right.beneficiary == address(0)) revert UnknownRight();
    }

    function claim(uint256 id) external nonReentrant {
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
