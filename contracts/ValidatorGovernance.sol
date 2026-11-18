// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Records consortium governance decisions for the AF3 prototype.
contract ValidatorGovernance {
    enum Sector { Regulator, LawEnforcement, Industry, Processor, Auditor, Academic }

    struct Validator {
        bool active;
        Sector sector;
    }

    struct Proposal {
        address candidate;
        Sector sector;
        bool add;
        bool executed;
        uint256 membershipVersion;
        uint256 requiredVotes;
        uint256 votes;
    }

    error InvalidChange();
    error InvalidProposal();
    error StaleProposal();
    error NotValidator();
    error DuplicateVote();
    error InsufficientVotes();

    event Proposed(uint256 indexed id, address indexed candidate, bool add, Sector sector, uint256 requiredVotes);
    event Voted(uint256 indexed id, address indexed validator);
    event ValidatorChanged(uint256 indexed id, address indexed candidate, bool active, Sector sector);

    uint256 public validatorCount;
    uint256 public membershipVersion;
    uint256 public proposalCount;
    mapping(address => Validator) public validators;
    mapping(Sector => uint256) public sectorCount;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    constructor(address[7] memory initialValidators, Sector[7] memory sectors) {
        for (uint256 i; i < initialValidators.length; ++i) {
            _validateChange(initialValidators[i], sectors[i], true);
            _applyChange(initialValidators[i], sectors[i], true);
        }
    }

    modifier onlyValidator() {
        if (!validators[msg.sender].active) revert NotValidator();
        _;
    }

    function propose(address candidate, Sector sector, bool add) external onlyValidator returns (uint256 id) {
        if (!add) sector = validators[candidate].sector;
        _validateChange(candidate, sector, add);
        id = ++proposalCount;
        uint256 requiredVotes = (2 * validatorCount) / 3 + 1;
        proposals[id] = Proposal(candidate, sector, add, false, membershipVersion, requiredVotes, 0);
        emit Proposed(id, candidate, add, sector, requiredVotes);
    }

    function vote(uint256 id) external onlyValidator {
        Proposal storage proposal = _pending(id);
        if (hasVoted[id][msg.sender]) revert DuplicateVote();
        hasVoted[id][msg.sender] = true;
        ++proposal.votes;
        emit Voted(id, msg.sender);
    }

    function execute(uint256 id) external onlyValidator {
        Proposal storage proposal = _pending(id);
        if (proposal.votes < proposal.requiredVotes) revert InsufficientVotes();
        _validateChange(proposal.candidate, proposal.sector, proposal.add);
        proposal.executed = true;
        _applyChange(proposal.candidate, proposal.sector, proposal.add);
        ++membershipVersion;
        emit ValidatorChanged(id, proposal.candidate, proposal.add, proposal.sector);
    }

    function _pending(uint256 id) private view returns (Proposal storage proposal) {
        proposal = proposals[id];
        if (id == 0 || id > proposalCount || proposal.executed) revert InvalidProposal();
        if (proposal.membershipVersion != membershipVersion) revert StaleProposal();
    }

    function _validateChange(address candidate, Sector sector, bool add) private view {
        if (candidate == address(0) || validators[candidate].active == add) revert InvalidChange();
        if (add && sectorCount[sector] >= 2) revert InvalidChange();
        if (!add && validatorCount <= 4) revert InvalidChange();
    }

    function _applyChange(address candidate, Sector sector, bool add) private {
        validators[candidate] = Validator(add, sector);
        if (add) {
            ++validatorCount;
            ++sectorCount[sector];
        } else {
            --validatorCount;
            --sectorCount[sector];
        }
    }
}
