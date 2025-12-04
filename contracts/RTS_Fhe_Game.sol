pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract RTSFheGameFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error InvalidArgument();
    error BatchNotOpen();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error AlreadyInitialized();

    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSecondsSet(uint32 oldValue, uint32 newValue);
    event ContractPaused();
    event ContractUnpaused();
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event ResourcesSubmitted(address indexed provider, uint256 indexed batchId, bytes32 encryptedTotal, bytes32 encryptedRate);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint32 totalResources, uint32 collectionRate);

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }

    struct PlayerData {
        euint32 encryptedTotalResources;
        euint32 encryptedCollectionRate;
    }

    mapping(address => bool) public isProvider;
    mapping(uint256 => mapping(address => PlayerData)) public playerData;
    mapping(uint256 => bool) public batchOpen;
    mapping(uint256 => DecryptionContext) public decryptionContexts;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    address public owner;
    uint32 public cooldownSeconds;
    uint256 public currentBatchId;
    bool public paused;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkCooldown(address _user) {
        if (block.timestamp < lastSubmissionTime[_user] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        cooldownSeconds = 30; // Default cooldown: 30 seconds
        currentBatchId = 1;
        batchOpen[currentBatchId] = true;
    }

    function addProvider(address _provider) external onlyOwner {
        if (_provider == address(0)) revert InvalidArgument();
        isProvider[_provider] = true;
        emit ProviderAdded(_provider);
    }

    function removeProvider(address _provider) external onlyOwner {
        if (!isProvider[_provider]) revert InvalidArgument();
        delete isProvider[_provider];
        emit ProviderRemoved(_provider);
    }

    function setCooldownSeconds(uint32 _cooldownSeconds) external onlyOwner {
        emit CooldownSecondsSet(cooldownSeconds, _cooldownSeconds);
        cooldownSeconds = _cooldownSeconds;
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit ContractPaused();
    }

    function unpause() external onlyOwner {
        if (!paused) revert InvalidArgument();
        paused = false;
        emit ContractUnpaused();
    }

    function openNewBatch() external onlyOwner {
        currentBatchId++;
        batchOpen[currentBatchId] = true;
        emit BatchOpened(currentBatchId);
    }

    function closeCurrentBatch() external onlyOwner {
        if (!batchOpen[currentBatchId]) revert InvalidArgument();
        batchOpen[currentBatchId] = false;
        emit BatchClosed(currentBatchId);
    }

    function submitEncryptedResources(
        euint32 _encryptedTotalResources,
        euint32 _encryptedCollectionRate
    ) external onlyProvider whenNotPaused checkCooldown(msg.sender) {
        if (!batchOpen[currentBatchId]) revert BatchNotOpen();
        if (!_encryptedTotalResources.isInitialized()) revert InvalidArgument();
        if (!_encryptedCollectionRate.isInitialized()) revert InvalidArgument();

        playerData[currentBatchId][msg.sender] = PlayerData({
            encryptedTotalResources: _encryptedTotalResources,
            encryptedCollectionRate: _encryptedCollectionRate
        });
        lastSubmissionTime[msg.sender] = block.timestamp;

        emit ResourcesSubmitted(
            msg.sender,
            currentBatchId,
            _encryptedTotalResources.toBytes32(),
            _encryptedCollectionRate.toBytes32()
        );
    }

    function requestDecryptionForPlayer(address _playerAddress) external onlyProvider whenNotPaused checkCooldown(msg.sender) {
        if (!batchOpen[currentBatchId]) revert BatchNotOpen();
        PlayerData storage data = playerData[currentBatchId][_playerAddress];
        if (!data.encryptedTotalResources.isInitialized() || !data.encryptedCollectionRate.isInitialized()) {
            revert InvalidArgument();
        }

        euint32[] memory ctsArray = new euint32[](2);
        ctsArray[0] = data.encryptedTotalResources;
        ctsArray[1] = data.encryptedCollectionRate;
        bytes32 stateHash = _hashCiphertexts(ctsArray);

        uint256 requestId = FHE.requestDecryption(ctsArray, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({
            batchId: currentBatchId,
            stateHash: stateHash,
            processed: false
        });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        emit DecryptionRequested(requestId, currentBatchId);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        // Rebuild ciphertexts array from storage in the same order
        PlayerData storage data = playerData[decryptionContexts[requestId].batchId][msg.sender]; // msg.sender is the provider who requested decryption
        euint32[] memory ctsArray = new euint32[](2);
        ctsArray[0] = data.encryptedTotalResources;
        ctsArray[1] = data.encryptedCollectionRate;

        bytes32 currentHash = _hashCiphertexts(ctsArray);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        FHE.checkSignatures(requestId, cleartexts, proof);

        uint32 totalResources = abi.decode(cleartexts[0:32], (uint32));
        uint32 collectionRate = abi.decode(cleartexts[32:64], (uint32));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, totalResources, collectionRate);
    }

    function _hashCiphertexts(euint32[] memory _cts) internal pure returns (bytes32) {
        bytes32[] memory ctsBytes = new bytes32[](_cts.length);
        for (uint i = 0; i < _cts.length; i++) {
            ctsBytes[i] = _cts[i].toBytes32();
        }
        return keccak256(abi.encode(ctsBytes, address(this)));
    }

    function _initIfNeeded(euint32 _val) internal view returns (euint32) {
        if (!_val.isInitialized()) {
            return FHE.asEuint32(0);
        }
        return _val;
    }

    function _requireInitialized(euint32 _val) internal pure {
        if (!_val.isInitialized()) revert InvalidArgument();
    }
}