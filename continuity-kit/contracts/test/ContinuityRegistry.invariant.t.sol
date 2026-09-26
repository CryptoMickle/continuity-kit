// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ContinuityRegistry} from "../src/ContinuityRegistry.sol";

/// @dev A synthetic owner whose model advances only for valid CAS writes.
contract RegistryHandler {
    ContinuityRegistry public immutable registry;
    bytes32 public constant MANIFEST = keccak256("synthetic-invariant-manifest");
    mapping(bytes32 stream => uint64 version) public versions;
    mapping(bytes32 stream => bytes32 digest) public digests;

    constructor(ContinuityRegistry registry_) {
        registry = registry_;
        for (uint256 i = 1; i <= 3; ++i) {
            bytes32 stream = bytes32(i);
            bytes32 digest = keccak256(abi.encode("synthetic-capsule", i));
            registry.create(stream, MANIFEST, digest);
            versions[stream] = 1;
            digests[stream] = digest;
        }
    }

    function write(uint256 streamSeed, bytes32 next, bool wrongVersion, bool wrongDigest) external {
        bytes32 stream = bytes32(streamSeed % 3 + 1);
        uint64 version = versions[stream];
        bytes32 digest = digests[stream];
        uint64 expectedVersion = wrongVersion ? version - 1 : version;
        bytes32 expectedDigest = wrongDigest ? bytes32(uint256(digest) ^ 1) : digest;
        bool shouldSucceed = !wrongVersion && !wrongDigest && next != bytes32(0) && next != digest;
        (bool success,) = address(registry)
            .call(abi.encodeCall(ContinuityRegistry.commit, (stream, expectedVersion, expectedDigest, next)));
        require(success == shouldSucceed, "CAS outcome diverged from model");
        if (success) {
            versions[stream] = version + 1;
            digests[stream] = next;
        }
    }

    function duplicateCreate(uint256 streamSeed, bytes32 manifest, bytes32 capsule) external {
        bytes32 stream = bytes32(streamSeed % 3 + 1);
        (bool success,) = address(registry).call(abi.encodeCall(ContinuityRegistry.create, (stream, manifest, capsule)));
        require(!success, "immutable enrollment replaced");
    }
}

contract ContinuityRegistryInvariantTest {
    ContinuityRegistry private registry;
    RegistryHandler private alice;
    RegistryHandler private bob;

    function setUp() public {
        registry = new ContinuityRegistry();
        alice = new RegistryHandler(registry);
        bob = new RegistryHandler(registry);
    }

    /// @dev Foundry discovers this target interface without a forge-std dependency.
    function targetContracts() external view returns (address[] memory targets) {
        targets = new address[](2);
        targets[0] = address(alice);
        targets[1] = address(bob);
    }

    function invariantOwnerStreamsMatchModelAndManifestsNeverChange() public view {
        assertOwner(alice);
        assertOwner(bob);
    }

    function assertOwner(RegistryHandler owner) private view {
        for (uint256 i = 1; i <= 3; ++i) {
            bytes32 stream = bytes32(i);
            (bool exists, bytes32 manifest, uint64 version, bytes32 digest) = registry.getHead(address(owner), stream);
            require(exists && manifest == owner.MANIFEST(), "enrollment invariant");
            require(version > 0 && version == owner.versions(stream), "version invariant");
            require(digest != bytes32(0) && digest == owner.digests(stream), "digest invariant");
        }
    }
}
