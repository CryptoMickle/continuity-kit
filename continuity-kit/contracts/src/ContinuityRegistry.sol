// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Immutable enrollment bindings and owner-authorized checkpoint heads.
/// @dev No administrator, ownership transfer, external calls, or upgrade mechanism.
contract ContinuityRegistry {
    struct Head {
        bytes32 manifestDigest;
        uint64 version;
        bytes32 capsuleDigest;
    }

    mapping(address owner => mapping(bytes32 streamId => Head)) private heads;

    error ZeroStreamId();
    error ZeroDigest();
    error AlreadyExists();
    error StreamNotFound();
    error WriteConflict(uint64 expectedVersion, uint64 actualVersion, bytes32 expectedDigest, bytes32 actualDigest);
    error NoChange();
    error VersionOverflow();

    event StreamCreated(
        address indexed owner, bytes32 indexed streamId, bytes32 manifestDigest, uint64 version, bytes32 capsuleDigest
    );
    event HeadCommitted(address indexed owner, bytes32 indexed streamId, uint64 version, bytes32 capsuleDigest);

    /// @notice Register an immutable manifest and version-one capsule for the caller.
    function create(bytes32 streamId, bytes32 manifestDigest, bytes32 initialCapsuleDigest) external {
        if (streamId == bytes32(0)) revert ZeroStreamId();
        if (manifestDigest == bytes32(0) || initialCapsuleDigest == bytes32(0)) revert ZeroDigest();
        Head storage head = heads[msg.sender][streamId];
        if (head.version != 0) revert AlreadyExists();

        head.manifestDigest = manifestDigest;
        head.version = 1;
        head.capsuleDigest = initialCapsuleDigest;
        emit StreamCreated(msg.sender, streamId, manifestDigest, 1, initialCapsuleDigest);
    }

    /// @notice Advance only the caller's head, conditional on both old version and digest.
    function commit(bytes32 streamId, uint64 expectedVersion, bytes32 expectedDigest, bytes32 nextDigest) external {
        if (streamId == bytes32(0)) revert ZeroStreamId();
        if (expectedDigest == bytes32(0) || nextDigest == bytes32(0)) revert ZeroDigest();
        Head storage head = heads[msg.sender][streamId];
        if (head.version == 0) revert StreamNotFound();
        if (head.version != expectedVersion || head.capsuleDigest != expectedDigest) {
            revert WriteConflict(expectedVersion, head.version, expectedDigest, head.capsuleDigest);
        }
        if (nextDigest == head.capsuleDigest) revert NoChange();
        if (head.version == type(uint64).max) revert VersionOverflow();

        head.version += 1;
        head.capsuleDigest = nextDigest;
        emit HeadCommitted(msg.sender, streamId, head.version, nextDigest);
    }

    /// @notice Absent records return (false, 0, 0, 0), including zero-valued lookup identifiers.
    function getHead(address owner, bytes32 streamId)
        external
        view
        returns (bool exists, bytes32 manifestDigest, uint64 version, bytes32 capsuleDigest)
    {
        Head storage head = heads[owner][streamId];
        return (head.version != 0, head.manifestDigest, head.version, head.capsuleDigest);
    }
}
