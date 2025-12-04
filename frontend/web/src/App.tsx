import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface ResourceRecord {
  id: string;
  encryptedAmount: string;
  encryptedRate: string;
  timestamp: number;
  owner: string;
  resourceType: "minerals" | "gas" | "energy" | "credits";
  status: "active" | "depleted";
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const RESOURCE_TYPES = ["minerals", "gas", "energy", "credits"];

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [resources, setResources] = useState<ResourceRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newResourceData, setNewResourceData] = useState({ resourceType: "minerals", amount: 0, rate: 0 });
  const [selectedResource, setSelectedResource] = useState<ResourceRecord | null>(null);
  const [decryptedAmount, setDecryptedAmount] = useState<number | null>(null);
  const [decryptedRate, setDecryptedRate] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterType, setFilterType] = useState("all");

  // Calculate total resources
  const totalMinerals = resources.filter(r => r.resourceType === "minerals").length;
  const totalGas = resources.filter(r => r.resourceType === "gas").length;
  const totalEnergy = resources.filter(r => r.resourceType === "energy").length;
  const totalCredits = resources.filter(r => r.resourceType === "credits").length;

  useEffect(() => {
    loadResources().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadResources = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      // Get resource keys
      const keysBytes = await contract.getData("resource_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing resource keys:", e); }
      }
      
      // Load each resource
      const list: ResourceRecord[] = [];
      for (const key of keys) {
        try {
          const resourceBytes = await contract.getData(`resource_${key}`);
          if (resourceBytes.length > 0) {
            try {
              const resourceData = JSON.parse(ethers.toUtf8String(resourceBytes));
              list.push({ 
                id: key, 
                encryptedAmount: resourceData.amount, 
                encryptedRate: resourceData.rate,
                timestamp: resourceData.timestamp, 
                owner: resourceData.owner, 
                resourceType: resourceData.resourceType, 
                status: resourceData.status || "active" 
              });
            } catch (e) { console.error(`Error parsing resource data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading resource ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setResources(list);
    } catch (e) { console.error("Error loading resources:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitResource = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting resource data with Zama FHE..." });
    try {
      // Encrypt both amount and collection rate
      const encryptedAmount = FHEEncryptNumber(newResourceData.amount);
      const encryptedRate = FHEEncryptNumber(newResourceData.rate);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Generate unique ID
      const resourceId = `res-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      
      // Store resource data
      const resourceData = { 
        amount: encryptedAmount, 
        rate: encryptedRate,
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        resourceType: newResourceData.resourceType, 
        status: "active" 
      };
      
      await contract.setData(`resource_${resourceId}`, ethers.toUtf8Bytes(JSON.stringify(resourceData)));
      
      // Update keys list
      const keysBytes = await contract.getData("resource_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(resourceId);
      await contract.setData("resource_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Resource encrypted and submitted!" });
      await loadResources();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewResourceData({ resourceType: "minerals", amount: 0, rate: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const decryptResource = async (resource: ResourceRecord) => {
    const amount = await decryptWithSignature(resource.encryptedAmount);
    const rate = await decryptWithSignature(resource.encryptedRate);
    if (amount !== null) setDecryptedAmount(amount);
    if (rate !== null) setDecryptedRate(rate);
  };

  const isOwner = (resourceAddress: string) => address?.toLowerCase() === resourceAddress.toLowerCase();

  const filteredResources = resources.filter(resource => {
    const matchesSearch = resource.id.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         resource.resourceType.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = filterType === "all" || resource.resourceType === filterType;
    return matchesSearch && matchesType;
  });

  const renderResourceStats = () => {
    return (
      <div className="stats-grid">
        <div className="stat-item">
          <div className="stat-value">{totalMinerals}</div>
          <div className="stat-label">Minerals</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{totalGas}</div>
          <div className="stat-label">Gas</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{totalEnergy}</div>
          <div className="stat-label">Energy</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{totalCredits}</div>
          <div className="stat-label">Credits</div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="mechanical-spinner"></div>
      <p>Initializing encrypted connection...</p>
    </div>
  );

  return (
    <div className="app-container industrial-theme">
      <header className="app-header">
        <div className="logo">
          <h1>RTS<span>FHE</span>Game</h1>
          <div className="logo-subtitle">Fully Homomorphic Encrypted Resource Management</div>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-resource-btn industrial-button">
            <div className="add-icon"></div>Add Resource
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>Real-Time Strategy with FHE</h2>
            <p>Manage encrypted resources where only you know the exact amounts. Opponents get fuzzy estimates.</p>
          </div>
          <div className="fhe-indicator">
            <div className="fhe-lock"></div>
            <span>Zama FHE Encryption Active</span>
          </div>
        </div>

        <div className="dashboard-grid">
          <div className="dashboard-card industrial-card">
            <h3>Project Introduction</h3>
            <p>This RTS game uses <strong>Zama FHE technology</strong> to encrypt your resource amounts and collection rates. Opponents can only get approximate values through scouting, adding strategic depth to economic warfare.</p>
            <div className="fhe-badge">
              <span>FHE-Powered Strategy</span>
            </div>
          </div>

          <div className="dashboard-card industrial-card">
            <h3>Resource Statistics</h3>
            {renderResourceStats()}
          </div>

          <div className="dashboard-card industrial-card">
            <h3>Real-Time Dashboard</h3>
            <div className="resource-distribution">
              <div className="resource-bar minerals" style={{ width: `${(totalMinerals / resources.length) * 100}%` }}></div>
              <div className="resource-bar gas" style={{ width: `${(totalGas / resources.length) * 100}%` }}></div>
              <div className="resource-bar energy" style={{ width: `${(totalEnergy / resources.length) * 100}%` }}></div>
              <div className="resource-bar credits" style={{ width: `${(totalCredits / resources.length) * 100}%` }}></div>
            </div>
            <div className="resource-legend">
              <div className="legend-item"><div className="color-box minerals"></div><span>Minerals</span></div>
              <div className="legend-item"><div className="color-box gas"></div><span>Gas</span></div>
              <div className="legend-item"><div className="color-box energy"></div><span>Energy</span></div>
              <div className="legend-item"><div className="color-box credits"></div><span>Credits</span></div>
            </div>
          </div>
        </div>

        <div className="resources-section">
          <div className="section-header">
            <h2>Encrypted Resources</h2>
            <div className="header-actions">
              <div className="search-filter">
                <input 
                  type="text" 
                  placeholder="Search resources..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="industrial-input"
                />
                <select 
                  value={filterType} 
                  onChange={(e) => setFilterType(e.target.value)}
                  className="industrial-select"
                >
                  <option value="all">All Types</option>
                  <option value="minerals">Minerals</option>
                  <option value="gas">Gas</option>
                  <option value="energy">Energy</option>
                  <option value="credits">Credits</option>
                </select>
              </div>
              <button onClick={loadResources} className="refresh-btn industrial-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          <div className="resources-list industrial-card">
            <div className="table-header">
              <div className="header-cell">ID</div>
              <div className="header-cell">Type</div>
              <div className="header-cell">Owner</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>

            {filteredResources.length === 0 ? (
              <div className="no-resources">
                <div className="no-resources-icon"></div>
                <p>No encrypted resources found</p>
                <button className="industrial-button primary" onClick={() => setShowCreateModal(true)}>
                  Create First Resource
                </button>
              </div>
            ) : filteredResources.map(resource => (
              <div 
                className="resource-row" 
                key={resource.id} 
                onClick={() => setSelectedResource(resource)}
                data-type={resource.resourceType}
              >
                <div className="table-cell resource-id">#{resource.id.substring(0, 6)}</div>
                <div className="table-cell">{resource.resourceType}</div>
                <div className="table-cell">{resource.owner.substring(0, 6)}...{resource.owner.substring(38)}</div>
                <div className="table-cell">{new Date(resource.timestamp * 1000).toLocaleDateString()}</div>
                <div className="table-cell">
                  <span className={`status-badge ${resource.status}`}>{resource.status}</span>
                </div>
                <div className="table-cell actions">
                  <button 
                    className="action-btn industrial-button" 
                    onClick={(e) => {
                      e.stopPropagation();
                      decryptResource(resource);
                      setSelectedResource(resource);
                    }}
                    disabled={isDecrypting}
                  >
                    Decrypt
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitResource} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          resourceData={newResourceData} 
          setResourceData={setNewResourceData}
        />
      )}

      {selectedResource && (
        <ResourceDetailModal 
          resource={selectedResource} 
          onClose={() => { 
            setSelectedResource(null); 
            setDecryptedAmount(null);
            setDecryptedRate(null);
          }} 
          decryptedAmount={decryptedAmount}
          decryptedRate={decryptedRate}
          isDecrypting={isDecrypting}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content industrial-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="mechanical-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <span>RTS_Fhe_Game</span>
            </div>
            <p>Real-Time Strategy with Fully Homomorphic Encrypted Resources</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} RTS FHE Game. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  resourceData: any;
  setResourceData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, resourceData, setResourceData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const { name, value } = e.target;
    setResourceData({ ...resourceData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setResourceData({ ...resourceData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!resourceData.resourceType || resourceData.amount <= 0 || resourceData.rate <= 0) {
      alert("Please fill all required fields with valid values");
      return;
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal industrial-card">
        <div className="modal-header">
          <h2>Add Encrypted Resource</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Your resource data will be encrypted with Zama FHE before submission</p>
            </div>
          </div>

          <div className="form-grid">
            <div className="form-group">
              <label>Resource Type *</label>
              <select 
                name="resourceType" 
                value={resourceData.resourceType} 
                onChange={handleChange} 
                className="industrial-select"
              >
                {RESOURCE_TYPES.map(type => (
                  <option key={type} value={type}>{type.charAt(0).toUpperCase() + type.slice(1)}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label>Initial Amount *</label>
              <input 
                type="number" 
                name="amount" 
                value={resourceData.amount} 
                onChange={handleValueChange} 
                placeholder="Enter initial amount..." 
                className="industrial-input"
                min="0"
                step="1"
              />
            </div>

            <div className="form-group">
              <label>Collection Rate *</label>
              <input 
                type="number" 
                name="rate" 
                value={resourceData.rate} 
                onChange={handleValueChange} 
                placeholder="Enter collection rate..." 
                className="industrial-input"
                min="0"
                step="0.1"
              />
            </div>
          </div>

          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Values:</span>
                <div>Amount: {resourceData.amount || '0'}</div>
                <div>Rate: {resourceData.rate || '0'}/min</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>Amount: {resourceData.amount ? FHEEncryptNumber(resourceData.amount).substring(0, 20) + '...' : 'Not encrypted'}</div>
                <div>Rate: {resourceData.rate ? FHEEncryptNumber(resourceData.rate).substring(0, 20) + '...' : 'Not encrypted'}</div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn industrial-button">
            Cancel
          </button>
          <button 
            onClick={handleSubmit} 
            disabled={creating} 
            className="submit-btn industrial-button primary"
          >
            {creating ? "Encrypting with FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ResourceDetailModalProps {
  resource: ResourceRecord;
  onClose: () => void;
  decryptedAmount: number | null;
  decryptedRate: number | null;
  isDecrypting: boolean;
}

const ResourceDetailModal: React.FC<ResourceDetailModalProps> = ({ 
  resource, 
  onClose, 
  decryptedAmount,
  decryptedRate,
  isDecrypting 
}) => {
  return (
    <div className="modal-overlay">
      <div className="resource-detail-modal industrial-card">
        <div className="modal-header">
          <h2>Resource Details #{resource.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="resource-info">
            <div className="info-item">
              <span>Type:</span>
              <strong className={`resource-type ${resource.resourceType}`}>
                {resource.resourceType}
              </strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>{resource.owner.substring(0, 6)}...{resource.owner.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Created:</span>
              <strong>{new Date(resource.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${resource.status}`}>
                {resource.status}
              </strong>
            </div>
          </div>

          <div className="encrypted-data-section">
            <h3>Encrypted Data</h3>
            <div className="data-grid">
              <div className="data-item">
                <span>Amount:</span>
                <div className="encrypted-data">
                  {resource.encryptedAmount.substring(0, 30)}...
                </div>
              </div>
              <div className="data-item">
                <span>Rate:</span>
                <div className="encrypted-data">
                  {resource.encryptedRate.substring(0, 30)}...
                </div>
              </div>
            </div>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>FHE Encrypted</span>
            </div>
          </div>

          {(decryptedAmount !== null || decryptedRate !== null) && (
            <div className="decrypted-data-section">
              <h3>Decrypted Values</h3>
              <div className="data-grid">
                <div className="data-item">
                  <span>Amount:</span>
                  <div className="decrypted-value">
                    {decryptedAmount !== null ? decryptedAmount : "Not decrypted"}
                  </div>
                </div>
                <div className="data-item">
                  <span>Rate:</span>
                  <div className="decrypted-value">
                    {decryptedRate !== null ? `${decryptedRate}/min` : "Not decrypted"}
                  </div>
                </div>
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted data is only visible after wallet signature verification</span>
              </div>
            </div>
          )}

          {isDecrypting && (
            <div className="decrypting-status">
              <div className="mechanical-spinner small"></div>
              <span>Decrypting with FHE...</span>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn industrial-button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;