// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

contract ChainWasteRegistry is AccessControl {
    bytes32 public constant REGULATOR_ROLE = keccak256("REGULATOR_ROLE");
    bytes32 public constant GENERATOR_ROLE = keccak256("GENERATOR_ROLE");
    bytes32 public constant TRANSPORTER_ROLE = keccak256("TRANSPORTER_ROLE");
    bytes32 public constant PROCESSOR_ROLE = keccak256("PROCESSOR_ROLE");
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");
    bytes32 public constant IOT_ORACLE_ROLE = keccak256("IOT_ORACLE_ROLE");
    uint256 public constant MAX_WEIGHT_KG = 100_000;

    enum Status { Created, InTransit, Received, Treated }

    struct Manifest {
        address generator;
        address transporter;
        address processor;
        bytes32 wasteCode;
        uint256 declaredWeightKg;
        uint256 pickupWeightKg;
        uint256 receivedWeightKg;
        bytes32 docHash;
        bytes32 sealHash;
        bytes32 treatmentProofHash;
        Status status;
        bool flagged;
        uint256 createdAt;
        uint256 updatedAt;
        uint256 toleranceBps;
    }

    error InvalidInput();
    error UnknownManifest(uint256 id);
    error WrongStatus(Status expected, Status actual);
    error WrongActor();
    error WeightAlreadyRecorded();
    error WeightMissing();
    error FlagStillOpen();
    error FlagNotOpen();

    event ManifestCreated(uint256 indexed id, address indexed generator, bytes32 docHash);
    event StatusChanged(uint256 indexed id, Status status);
    event WeightRecorded(uint256 indexed id, bool pickup, uint256 kg, bytes32 sealHash);
    event AnomalyDetected(uint256 indexed id, uint256 pickupKg, uint256 receivedKg);
    event ManuallyFlagged(uint256 indexed id, bytes32 reasonHash);
    event FlagResolved(uint256 indexed id, bytes32 noteHash);
    event TreatmentRecorded(uint256 indexed id, bytes32 proofHash);
    event ToleranceChanged(uint256 bps);

    uint256 public manifestCount;
    uint256 public toleranceBps = 500;
    mapping(uint256 => Manifest) private manifests;
    mapping(address => uint256[]) private byGenerator;

    constructor(address regulator) {
        if (regulator == address(0)) revert InvalidInput();
        _setRoleAdmin(REGULATOR_ROLE, REGULATOR_ROLE);
        _setRoleAdmin(GENERATOR_ROLE, REGULATOR_ROLE);
        _setRoleAdmin(TRANSPORTER_ROLE, REGULATOR_ROLE);
        _setRoleAdmin(PROCESSOR_ROLE, REGULATOR_ROLE);
        _setRoleAdmin(AUDITOR_ROLE, REGULATOR_ROLE);
        _setRoleAdmin(IOT_ORACLE_ROLE, REGULATOR_ROLE);
        _grantRole(REGULATOR_ROLE, regulator);
    }

    function registerActor(address actor, bytes32 role) external {
        if (actor == address(0)) revert InvalidInput();
        grantRole(role, actor);
    }

    function revokeActor(address actor, bytes32 role) external {
        revokeRole(role, actor);
    }

    function setTolerance(uint256 bps) external onlyRole(REGULATOR_ROLE) {
        if (bps > 10_000) revert InvalidInput();
        toleranceBps = bps;
        emit ToleranceChanged(bps);
    }

    function createManifest(
        address transporter,
        address processor,
        bytes32 wasteCode,
        uint256 declaredWeightKg,
        bytes32 docHash
    ) external onlyRole(GENERATOR_ROLE) returns (uint256 id) {
        if (transporter == address(0) || processor == address(0)) revert InvalidInput();
        if (wasteCode == bytes32(0) || docHash == bytes32(0)) revert InvalidInput();
        _checkRole(TRANSPORTER_ROLE, transporter);
        _checkRole(PROCESSOR_ROLE, processor);
        _checkWeight(declaredWeightKg);

        id = ++manifestCount;
        Manifest storage item = manifests[id];
        item.generator = msg.sender;
        item.transporter = transporter;
        item.processor = processor;
        item.wasteCode = wasteCode;
        item.declaredWeightKg = declaredWeightKg;
        item.docHash = docHash;
        item.createdAt = block.timestamp;
        item.updatedAt = block.timestamp;
        item.toleranceBps = toleranceBps;
        byGenerator[msg.sender].push(id);
        emit ManifestCreated(id, msg.sender, docHash);
    }

    function recordPickupWeight(uint256 id, uint256 kg, bytes32 sealHash) external onlyRole(IOT_ORACLE_ROLE) {
        Manifest storage item = _atStatus(id, Status.Created);
        _checkWeight(kg);
        if (sealHash == bytes32(0)) revert InvalidInput();
        if (item.pickupWeightKg != 0) revert WeightAlreadyRecorded();
        item.pickupWeightKg = kg;
        item.sealHash = sealHash;
        item.updatedAt = block.timestamp;
        emit WeightRecorded(id, true, kg, sealHash);
    }

    function confirmPickup(uint256 id) external onlyRole(TRANSPORTER_ROLE) {
        Manifest storage item = _atStatus(id, Status.Created);
        if (item.transporter != msg.sender) revert WrongActor();
        if (item.pickupWeightKg == 0) revert WeightMissing();
        _advance(id, item, Status.InTransit);
    }

    function recordReceivedWeight(uint256 id, uint256 kg) external onlyRole(IOT_ORACLE_ROLE) {
        Manifest storage item = _atStatus(id, Status.InTransit);
        _checkWeight(kg);
        if (item.receivedWeightKg != 0) revert WeightAlreadyRecorded();
        item.receivedWeightKg = kg;
        item.updatedAt = block.timestamp;
        emit WeightRecorded(id, false, kg, bytes32(0));
    }

    function confirmReceipt(uint256 id) external onlyRole(PROCESSOR_ROLE) {
        Manifest storage item = _atStatus(id, Status.InTransit);
        if (item.processor != msg.sender) revert WrongActor();
        uint256 received = item.receivedWeightKg;
        if (received == 0) revert WeightMissing();
        uint256 pickup = item.pickupWeightKg;
        uint256 difference = pickup > received ? pickup - received : received - pickup;
        if (difference * 10_000 > pickup * item.toleranceBps) {
            item.flagged = true;
            emit AnomalyDetected(id, pickup, received);
        }
        _advance(id, item, Status.Received);
    }

    function markTreated(uint256 id, bytes32 treatmentProofHash) external onlyRole(PROCESSOR_ROLE) {
        Manifest storage item = _atStatus(id, Status.Received);
        if (item.processor != msg.sender) revert WrongActor();
        if (treatmentProofHash == bytes32(0)) revert InvalidInput();
        item.treatmentProofHash = treatmentProofHash;
        _advance(id, item, Status.Treated);
        emit TreatmentRecorded(id, treatmentProofHash);
    }

    function flagManually(uint256 id, bytes32 reasonHash) external onlyRole(AUDITOR_ROLE) {
        Manifest storage item = _manifest(id);
        if (reasonHash == bytes32(0)) revert InvalidInput();
        if (item.flagged) revert FlagStillOpen();
        item.flagged = true;
        item.updatedAt = block.timestamp;
        emit ManuallyFlagged(id, reasonHash);
    }

    function resolveFlag(uint256 id, bytes32 noteHash) external onlyRole(AUDITOR_ROLE) {
        Manifest storage item = _manifest(id);
        if (noteHash == bytes32(0)) revert InvalidInput();
        if (!item.flagged) revert FlagNotOpen();
        item.flagged = false;
        item.updatedAt = block.timestamp;
        emit FlagResolved(id, noteHash);
    }

    function getManifest(uint256 id) external view returns (Manifest memory) {
        return _manifest(id);
    }

    function getManifestsByGenerator(address generator) external view returns (uint256[] memory) {
        return byGenerator[generator];
    }

    function _manifest(uint256 id) private view returns (Manifest storage item) {
        if (id == 0 || id > manifestCount) revert UnknownManifest(id);
        return manifests[id];
    }

    function _atStatus(uint256 id, Status expected) private view returns (Manifest storage item) {
        item = _manifest(id);
        if (item.status != expected) revert WrongStatus(expected, item.status);
        if (item.flagged) revert FlagStillOpen();
    }

    function _advance(uint256 id, Manifest storage item, Status next) private {
        item.status = next;
        item.updatedAt = block.timestamp;
        emit StatusChanged(id, next);
    }

    function _checkWeight(uint256 kg) private pure {
        if (kg == 0 || kg > MAX_WEIGHT_KG) revert InvalidInput();
    }
}
