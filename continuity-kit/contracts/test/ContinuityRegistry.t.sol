// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ContinuityRegistry} from "../src/ContinuityRegistry.sol";

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address sender) external;
    function expectRevert(bytes calldata reason) external;
    function expectRevert(bytes4 selector) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function store(address target, bytes32 slot, bytes32 value) external;
    function assume(bool condition) external;
}

contract ContinuityRegistryTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant ALICE = address(0xa11ce);
    address private constant BOB = address(0xb0b);
    bytes32 private constant STREAM = keccak256("synthetic-stream");
    bytes32 private constant MANIFEST = keccak256("synthetic-manifest");
    bytes32 private constant FIRST = keccak256("synthetic-capsule-v1");
    bytes32 private constant SECOND = keccak256("synthetic-capsule-v2");
    bytes32 private constant THIRD = keccak256("synthetic-capsule-v3");
    ContinuityRegistry private registry;

    function setUp() public {
        registry = new ContinuityRegistry();
    }

    function testAbsentHead() public view {
        assertHead(ALICE, STREAM, false, bytes32(0), 0, bytes32(0));
        assertHead(address(0), bytes32(0), false, bytes32(0), 0, bytes32(0));
    }

    function testCreateBindsManifestAndVersionOne() public {
        enroll(ALICE, STREAM);
        assertHead(ALICE, STREAM, true, MANIFEST, 1, FIRST);
    }

    function testDuplicateCreateCannotReplaceManifest() public {
        enroll(ALICE, STREAM);
        vm.expectRevert(ContinuityRegistry.AlreadyExists.selector);
        vm.prank(ALICE);
        registry.create(STREAM, SECOND, THIRD);
        assertHead(ALICE, STREAM, true, MANIFEST, 1, FIRST);
    }

    function testOwnerIsolationSameStreamIdentifier() public {
        enroll(ALICE, STREAM);
        vm.expectRevert(ContinuityRegistry.StreamNotFound.selector);
        vm.prank(BOB);
        registry.commit(STREAM, 1, FIRST, SECOND);
        vm.prank(BOB);
        registry.create(STREAM, THIRD, SECOND);
        vm.prank(BOB);
        registry.commit(STREAM, 1, SECOND, THIRD);
        assertHead(ALICE, STREAM, true, MANIFEST, 1, FIRST);
        assertHead(BOB, STREAM, true, THIRD, 2, THIRD);
    }

    function testStreamIsolationSameOwner() public {
        enroll(ALICE, STREAM);
        enroll(ALICE, SECOND);
        vm.prank(ALICE);
        registry.commit(STREAM, 1, FIRST, SECOND);
        assertHead(ALICE, STREAM, true, MANIFEST, 2, SECOND);
        assertHead(ALICE, SECOND, true, MANIFEST, 1, FIRST);
    }

    function testCreateRejectsEachZeroInput() public {
        vm.expectRevert(ContinuityRegistry.ZeroStreamId.selector);
        registry.create(bytes32(0), MANIFEST, FIRST);
        vm.expectRevert(ContinuityRegistry.ZeroDigest.selector);
        registry.create(STREAM, bytes32(0), FIRST);
        vm.expectRevert(ContinuityRegistry.ZeroDigest.selector);
        registry.create(STREAM, MANIFEST, bytes32(0));
        assertHead(address(this), STREAM, false, bytes32(0), 0, bytes32(0));
    }

    function testCommitRejectsEachZeroInput() public {
        enroll(ALICE, STREAM);
        vm.expectRevert(ContinuityRegistry.ZeroStreamId.selector);
        vm.prank(ALICE);
        registry.commit(bytes32(0), 1, FIRST, SECOND);
        vm.expectRevert(ContinuityRegistry.ZeroDigest.selector);
        vm.prank(ALICE);
        registry.commit(STREAM, 1, bytes32(0), SECOND);
        vm.expectRevert(ContinuityRegistry.ZeroDigest.selector);
        vm.prank(ALICE);
        registry.commit(STREAM, 1, FIRST, bytes32(0));
        assertHead(ALICE, STREAM, true, MANIFEST, 1, FIRST);
    }

    function testAbsentCommitCannotCreateRecord() public {
        vm.expectRevert(ContinuityRegistry.StreamNotFound.selector);
        vm.prank(ALICE);
        registry.commit(STREAM, 1, FIRST, SECOND);
        assertHead(ALICE, STREAM, false, bytes32(0), 0, bytes32(0));
    }

    function testCASChecksVersionEvenWhenDigestMatches() public {
        enroll(ALICE, STREAM);
        conflict(0, FIRST, 1, FIRST);
        conflict(2, FIRST, 1, FIRST);
        assertHead(ALICE, STREAM, true, MANIFEST, 1, FIRST);
    }

    function testCASChecksDigestEvenWhenVersionMatches() public {
        enroll(ALICE, STREAM);
        conflict(1, THIRD, 1, FIRST);
        assertHead(ALICE, STREAM, true, MANIFEST, 1, FIRST);
    }

    function testTwoWritersOneWinnerAndReplayFails() public {
        enroll(ALICE, STREAM);
        vm.prank(ALICE);
        registry.commit(STREAM, 1, FIRST, SECOND);
        conflict(1, FIRST, 2, SECOND);
        assertHead(ALICE, STREAM, true, MANIFEST, 2, SECOND);
    }

    function testABAReplayFailsEvenIfOldDigestReturns() public {
        enroll(ALICE, STREAM);
        vm.prank(ALICE);
        registry.commit(STREAM, 1, FIRST, SECOND);
        vm.prank(ALICE);
        registry.commit(STREAM, 2, SECOND, FIRST);
        conflict(1, FIRST, 3, FIRST);
        assertHead(ALICE, STREAM, true, MANIFEST, 3, FIRST);
    }

    function testNoChangeRejected() public {
        enroll(ALICE, STREAM);
        vm.expectRevert(ContinuityRegistry.NoChange.selector);
        vm.prank(ALICE);
        registry.commit(STREAM, 1, FIRST, FIRST);
        assertHead(ALICE, STREAM, true, MANIFEST, 1, FIRST);
    }

    function testVersionOverflowRejected() public {
        enroll(ALICE, STREAM);
        // Reach an otherwise impractically distant boundary in this synthetic test only.
        bytes32 ownerSlot = keccak256(abi.encode(ALICE, uint256(0)));
        bytes32 recordSlot = keccak256(abi.encode(STREAM, ownerSlot));
        vm.store(address(registry), bytes32(uint256(recordSlot) + 1), bytes32(uint256(type(uint64).max)));
        vm.expectRevert(ContinuityRegistry.VersionOverflow.selector);
        vm.prank(ALICE);
        registry.commit(STREAM, type(uint64).max, FIRST, SECOND);
        assertHead(ALICE, STREAM, true, MANIFEST, type(uint64).max, FIRST);
    }

    function testEventsIdentifyCreationAndCommittedHead() public {
        vm.recordLogs();
        enroll(ALICE, STREAM);
        vm.prank(ALICE);
        registry.commit(STREAM, 1, FIRST, SECOND);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 2, "event count");
        assertEvent(logs[0], keccak256("StreamCreated(address,bytes32,bytes32,uint64,bytes32)"));
        require(keccak256(logs[0].data) == keccak256(abi.encode(MANIFEST, uint64(1), FIRST)), "creation data");
        assertEvent(logs[1], keccak256("HeadCommitted(address,bytes32,uint64,bytes32)"));
        require(keccak256(logs[1].data) == keccak256(abi.encode(uint64(2), SECOND)), "commit data");
    }

    function testFuzzOwnerAndStreamIsolation(address owner, address other, bytes32 stream) public {
        vm.assume(owner != address(0) && other != address(0) && owner != other && stream != bytes32(0));
        enroll(owner, stream);
        enroll(other, stream);
        vm.prank(owner);
        registry.commit(stream, 1, FIRST, SECOND);
        assertHead(owner, stream, true, MANIFEST, 2, SECOND);
        assertHead(other, stream, true, MANIFEST, 1, FIRST);
    }

    function testFuzzManifestImmutableAndVersionsProgress(bytes32 seed, uint8 steps) public {
        enroll(ALICE, STREAM);
        uint64 version = 1;
        bytes32 digest = FIRST;
        uint256 count = uint256(steps) % 64 + 1;
        for (uint256 i; i < count; ++i) {
            bytes32 next = keccak256(abi.encode(seed, i));
            vm.assume(next != bytes32(0) && next != digest);
            vm.prank(ALICE);
            registry.commit(STREAM, version, digest, next);
            version += 1;
            digest = next;
            assertHead(ALICE, STREAM, true, MANIFEST, version, digest);
        }
    }

    function enroll(address owner, bytes32 stream) private {
        vm.prank(owner);
        registry.create(stream, MANIFEST, FIRST);
    }

    function conflict(uint64 expectedVersion, bytes32 expectedDigest, uint64 actualVersion, bytes32 actualDigest)
        private
    {
        vm.expectRevert(
            abi.encodeWithSelector(
                ContinuityRegistry.WriteConflict.selector, expectedVersion, actualVersion, expectedDigest, actualDigest
            )
        );
        vm.prank(ALICE);
        registry.commit(STREAM, expectedVersion, expectedDigest, THIRD);
    }

    function assertEvent(Vm.Log memory log, bytes32 signature) private view {
        require(log.emitter == address(registry), "event emitter");
        require(log.topics.length == 3 && log.topics[0] == signature, "event signature");
        require(log.topics[1] == bytes32(uint256(uint160(ALICE))) && log.topics[2] == STREAM, "event identity");
    }

    function assertHead(address owner, bytes32 stream, bool exists, bytes32 manifest, uint64 version, bytes32 digest)
        private
        view
    {
        (bool gotExists, bytes32 gotManifest, uint64 gotVersion, bytes32 gotDigest) = registry.getHead(owner, stream);
        require(gotExists == exists && gotManifest == manifest && gotVersion == version && gotDigest == digest, "head");
    }
}
