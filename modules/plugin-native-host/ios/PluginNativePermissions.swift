import AVFoundation
import CoreLocation
import Foundation
import Photos
import UserNotifications

/// Permissions the host exposes. Anything outside this list is rejected.
enum PluginNativePermission: String {
  case microphone
  case camera
  case photoLibrary
  case notifications
  case locationWhenInUse
}

/// Permission states shared with the plugin runtime.
enum PluginNativePermissionStatus: String {
  case granted
  case denied
  case blocked
  case limited
  case unavailable
  case notDetermined
}

/**
 Maps system authorization states onto the host contract. iOS only shows the
 prompt once, so `.denied` and `.restricted` are reported as `blocked` and the
 plugin is expected to point the user at the system settings.
 */
enum PluginNativePermissionMapper {
  static func microphoneStatus(_ status: AVAudioSession.RecordPermission) -> PluginNativePermissionStatus {
    switch status {
    case .granted:
      return .granted
    case .denied:
      return .blocked
    case .undetermined:
      return .notDetermined
    @unknown default:
      return .unavailable
    }
  }

  static func cameraStatus(_ status: AVAuthorizationStatus) -> PluginNativePermissionStatus {
    switch status {
    case .authorized:
      return .granted
    case .denied, .restricted:
      return .blocked
    case .notDetermined:
      return .notDetermined
    @unknown default:
      return .unavailable
    }
  }

  static func photoStatus(_ status: PHAuthorizationStatus) -> PluginNativePermissionStatus {
    switch status {
    case .authorized:
      return .granted
    case .limited:
      return .limited
    case .denied, .restricted:
      return .blocked
    case .notDetermined:
      return .notDetermined
    @unknown default:
      return .unavailable
    }
  }

  static func notificationStatus(_ status: UNAuthorizationStatus) -> PluginNativePermissionStatus {
    switch status {
    case .authorized, .ephemeral:
      return .granted
    case .provisional:
      // Provisional delivery is quiet and can be upgraded by the user.
      return .limited
    case .denied:
      return .blocked
    case .notDetermined:
      return .notDetermined
    @unknown default:
      return .unavailable
    }
  }

  static func locationStatus(_ status: CLAuthorizationStatus) -> PluginNativePermissionStatus {
    switch status {
    case .authorizedAlways, .authorizedWhenInUse:
      return .granted
    case .denied, .restricted:
      return .blocked
    case .notDetermined:
      return .notDetermined
    @unknown default:
      return .unavailable
    }
  }
}

/**
 Queries and requests the supported permissions. Calls run on the main thread
 because the module dispatches its permission functions there; results are not
 cached so every call reflects the current system state.
 */
final class PluginNativePermissionService {
  static let shared = PluginNativePermissionService()

  typealias StatusCompletion = (PluginNativePermissionStatus) -> Void
  typealias RequestCompletion = (Result<PluginNativePermissionStatus, PluginNativeHostError>) -> Void

  private var locationRequesters: [ObjectIdentifier: LocationAuthorizationRequester] = [:]

  private init() {}

  func getStatus(_ permission: PluginNativePermission, completion: @escaping StatusCompletion) {
    switch permission {
    case .microphone:
      completion(PluginNativePermissionMapper.microphoneStatus(AVAudioSession.sharedInstance().recordPermission))
    case .camera:
      completion(PluginNativePermissionMapper.cameraStatus(AVCaptureDevice.authorizationStatus(for: .video)))
    case .photoLibrary:
      completion(PluginNativePermissionMapper.photoStatus(PHPhotoLibrary.authorizationStatus(for: .readWrite)))
    case .notifications:
      UNUserNotificationCenter.current().getNotificationSettings { settings in
        let status = PluginNativePermissionMapper.notificationStatus(settings.authorizationStatus)
        DispatchQueue.main.async {
          completion(status)
        }
      }
    case .locationWhenInUse:
      guard CLLocationManager.locationServicesEnabled() else {
        completion(.unavailable)
        return
      }
      completion(PluginNativePermissionMapper.locationStatus(CLLocationManager.authorizationStatus()))
    }
  }

  func request(_ permission: PluginNativePermission, completion: @escaping RequestCompletion) {
    switch permission {
    case .microphone:
      AVAudioSession.sharedInstance().requestRecordPermission { _ in
        DispatchQueue.main.async {
          let status = PluginNativePermissionMapper.microphoneStatus(AVAudioSession.sharedInstance().recordPermission)
          completion(.success(status))
        }
      }
    case .camera:
      AVCaptureDevice.requestAccess(for: .video) { _ in
        DispatchQueue.main.async {
          completion(.success(PluginNativePermissionMapper.cameraStatus(AVCaptureDevice.authorizationStatus(for: .video))))
        }
      }
    case .photoLibrary:
      PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in
        DispatchQueue.main.async {
          completion(.success(PluginNativePermissionMapper.photoStatus(PHPhotoLibrary.authorizationStatus(for: .readWrite))))
        }
      }
    case .notifications:
      UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { _, error in
        guard error == nil else {
          DispatchQueue.main.async {
            completion(.failure(PluginNativeHostError.nativeError("通知权限请求失败，请稍后重试")))
          }
          return
        }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
          let status = PluginNativePermissionMapper.notificationStatus(settings.authorizationStatus)
          DispatchQueue.main.async {
            completion(.success(status))
          }
        }
      }
    case .locationWhenInUse:
      requestLocationWhenInUse(completion: completion)
    }
  }

  private func requestLocationWhenInUse(completion: @escaping RequestCompletion) {
    guard CLLocationManager.locationServicesEnabled() else {
      completion(.failure(PluginNativeHostError.unavailable("当前设备未开启定位服务，请前往系统设置开启")))
      return
    }

    let currentStatus = CLLocationManager.authorizationStatus()
    guard currentStatus == .notDetermined else {
      completion(.success(PluginNativePermissionMapper.locationStatus(currentStatus)))
      return
    }

    let requester = LocationAuthorizationRequester()
    locationRequesters[ObjectIdentifier(requester)] = requester
    requester.request { [weak self, weak requester] status in
      guard let requester else {
        return
      }
      self?.locationRequesters.removeValue(forKey: ObjectIdentifier(requester))
      completion(.success(status))
    }
  }
}

/**
 Holds a `CLLocationManager` for the duration of a single authorization request.
 The manager is released as soon as the system answers, so the host never keeps
 location hardware alive on its own.
 */
final class LocationAuthorizationRequester: NSObject, CLLocationManagerDelegate {
  private lazy var manager = CLLocationManager()
  private var completion: ((PluginNativePermissionStatus) -> Void)?

  func request(completion: @escaping (PluginNativePermissionStatus) -> Void) {
    self.completion = completion
    manager.delegate = self
    manager.requestWhenInUseAuthorization()
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    let status = manager.authorizationStatus
    // The delegate fires once on assignment, before the user answered the dialog.
    guard status != .notDetermined else {
      return
    }
    finish(with: status)
  }

  private func finish(with status: CLAuthorizationStatus) {
    guard let completion else {
      return
    }
    self.completion = nil
    manager.delegate = nil

    let mapped = PluginNativePermissionMapper.locationStatus(status)
    // Defer so the manager is released after the delegate callback unwinds.
    DispatchQueue.main.async {
      completion(mapped)
    }
  }
}
